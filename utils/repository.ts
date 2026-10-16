/** UI mutations are acknowledged by the server before updating the cloud cache. */
import * as local from './store';
import { Pet, DiaryRecord, RawInput, getCloudSession, getCloudSessionEpoch, setCloudSession, cacheCloudData, uid } from './store';
import { callCloud, CloudError } from './cloud';
import { reconcileFamilyState, forgetFamilyState } from './family-state';
import { TraceObserver, traceError } from './debug-trace';

export interface Family {
  id: string; name: string;
  members: Array<{ userId: string; role: 'owner' | 'member'; joinedAt: number; nickname?: string }>;
}
interface CloudDiary {
  id: string; familyId: string; petId: string; rawInput: RawInput;
  formatted: { date: string; text: string; tags: string[]; photos: string[] };
  createdAt: number; updatedAt: number; createdBy: string; version: number;
  formatting: { schemaVersion: number; mode: string };
}
function session() {
  const s = getCloudSession();
  if (!s) throw new CloudError('UNAUTHENTICATED', '请先登录');
  if (!s.familyId) throw new CloudError('NO_FAMILY', '请先创建或加入一个家庭空间');
  return { ...s, epoch: getCloudSessionEpoch() };
}
const sameSession = (s: local.CloudSession & { epoch?: number }) => {
  const current = getCloudSession();
  if (!current || current.userId !== s.userId || current.familyId !== s.familyId
    || (s.epoch !== undefined && s.epoch !== getCloudSessionEpoch())) throw new CloudError('SESSION_CHANGED', '账号或家庭空间已切换，请重试');
};
function mediaKey(s: local.CloudSession) { return `jd_media_${s.userId}_${s.familyId}`; }
function mediaMap(s: local.CloudSession): Record<string, string> { return wx.getStorageSync(mediaKey(s)) || {}; }
async function mapUrls(ids: string[], s: local.CloudSession): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const unique = Array.from(new Set(ids));
  for (let i = 0; i < unique.length; i += 9) {
    const rows = await callCloud<Array<{ fileId: string; url: string }>>('media.urls', { familyId: s.familyId, fileIds: unique.slice(i, i + 9) });
    rows.forEach((row) => { map[row.fileId] = row.url; });
  }
  sameSession(s);
  const reverse = mediaMap(s);
  Object.keys(map).forEach((id) => { reverse[map[id]] = id; reverse[id] = id; });
  wx.setStorageSync(mediaKey(s), reverse);
  return map;
}
async function uploadPhotos(paths: string[], s: local.CloudSession, observe?: TraceObserver): Promise<string[]> {
  const ids: string[] = [];
  const emit: TraceObserver = (phase, detail) => { try { observe?.(phase, detail); } catch (_) { /* 日志不能影响保存 */ } };
  for (const path of paths) {
    sameSession(s);
    const known = mediaMap(s)[path];
    if (known) { ids.push(known); continue; }
    if (path.indexOf('cloud://') === 0) { ids.push(path); continue; } // Server validates family ownership.
    // 只拒绝云存储的签名展示链接；部分机型的本机持久路径以 http:// 开头（USER_DATA_PATH），必须照常上传
    if (/^https:/.test(path)) throw new Error('照片链接已失效，请刷新后重试');
    let stage = 'read';
    const photoIndex = ids.length;
    try {
      emit('photo.start', { photoIndex });
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => (wx.getFileSystemManager() as any).readFile({
        filePath: path, success: (r: any) => resolve(r.data), fail: () => reject(new CloudError('PHOTO_READ', '照片读取失败，请重新选择照片')),
      }));
      sameSession(s);
      emit('photo.read', { photoIndex, sourceBytes: bytes.byteLength });
      // 二进制直接传到服务端签发的临时地址，不将照片塞进云函数 JSON，也不重复压缩。
      stage = 'prepare';
      const grant = await callCloud<{ uploadId: string; url: string; headers: Record<string, string> }>('media.prepare', { familyId: s.familyId });
      sameSession(s);
      stage = 'upload';
      emit('photo.upload', { photoIndex, sourceBytes: bytes.byteLength, uploadBytes: bytes.byteLength });
      await new Promise<void>((resolve, reject) => wx.request({
        url: grant.url, method: 'PUT', data: bytes, header: grant.headers, timeout: 120000,
        success: (r: any) => r.statusCode >= 200 && r.statusCode < 300 ? resolve() : reject(new CloudError('PHOTO_UPLOAD', '照片上传失败，请重试')),
        fail: () => reject(new CloudError('PHOTO_UPLOAD', '照片上传失败，请检查网络后重试')),
      }));
      sameSession(s);
      stage = 'complete';
      const result = await callCloud<{ fileId: string }>('media.complete', { familyId: s.familyId, uploadId: grant.uploadId });
      sameSession(s);
      emit('photo.complete', { photoIndex, sourceBytes: bytes.byteLength, uploadBytes: bytes.byteLength });
      wx.setStorageSync(mediaKey(s), { ...mediaMap(s), [path]: result.fileId, [result.fileId]: result.fileId });
      ids.push(result.fileId);
    } catch (error) {
      emit('photo.failure', { photoIndex, path: stage, error: traceError(error) });
      throw error;
    }
  }
  return ids;
}
async function allPages<T>(action: string, data: object): Promise<T[]> {
  let after = '';
  const all: T[] = [];
  do {
    const page = await callCloud<{ items: T[]; next: string }>(action, { ...data, after, limit: 10 });
    all.push(...page.items);
    after = page.next;
  } while (after);
  return all;
}
function hydrate(d: CloudDiary, urls: Record<string, string>): DiaryRecord {
  return { id: d.id, familyId: d.familyId, petId: d.petId, ...d.formatted,
    photos: d.formatted.photos.map((id) => urls[id] || id), rawInput: d.rawInput,
    createdAt: d.createdAt, updatedAt: d.updatedAt, createdBy: d.createdBy, version: d.version, formatting: d.formatting };
}
export async function refreshCloud(): Promise<void> {
  if (!getCloudSession()?.familyId) return;
  const s = session();
  const revision = local.getCloudCacheRevision();
  try {
    const identity = await callCloud<{ id: string }>('auth.login');
    if (identity.id !== s.userId) throw new CloudError('UNAUTHENTICATED', '微信账号已变更，请重新连接云端');
    const cloudPets = await allPages<Pet>('pet.list', { familyId: s.familyId });
    const diaries: CloudDiary[] = [];
    for (const pet of cloudPets) diaries.push(...await allPages<CloudDiary>('diary.list', { familyId: s.familyId, petId: pet.id }));
    const avatarIds = cloudPets.map((p) => p.avatar || '').filter(Boolean);
    const urls = await mapUrls(diaries.flatMap((d) => d.formatted.photos).concat(avatarIds), s);
    sameSession(s);
    // 宠物头像在云端存 fileId，缓存里统一换成可展示的临时链接（与日记照片同一生命周期）
    const pets = cloudPets.map((p) => ({ ...p, avatar: p.avatar ? (urls[p.avatar] || '') : '' }));
    if (local.getCloudCacheRevision() === revision) cacheCloudData(pets, diaries.map((d) => hydrate(d, urls)));
  } catch (error) {
    if (error instanceof CloudError && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)) {
      sameSession(s);
      local.clearAll();
      if (error.code === 'FORBIDDEN') {
        // 云端明确拒绝访问时立即切断旧空间，待家庭页重新确认剩余家庭。
        forgetFamilyState(s.userId, s.familyId);
        setCloudSession({ userId: s.userId, familyId: '' });
      }
    }
    throw error;
  }
}

/**
 * 已上传过的本机路径 / 临时链接 → 云端 fileId；没传过的返回空串。
 * 只做查询，绝不触发上传——照片是否在云端由「有没有保存进日记」决定。
 */
export function cloudFileIds(paths: string[]): string[] {
  if (!paths.length) return [];
  const map = mediaMap(session());
  return paths.map((p) => map[p] || '');
}

/** 云端 fileId → 可展示的临时链接 */
export async function resolvePhotoUrls(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  return mapUrls(ids, session());
}

let lastRefreshAt = 0;
let lastRefreshScope = '';
let inflightRefresh: Promise<void> | null = null;
let inflightRefreshScope = '';
/**
 * 节流 + 去重的云端刷新：tab 页 onShow 高频触发时，间隔内直接跳过、并发请求合并为一次。
 * 返回是否真的发起了刷新（false = 命中节流被跳过）。
 */
export function refreshCloudIfStale(maxAgeMs = 30000): Promise<boolean> {
  const current = getCloudSession();
  if (!current?.familyId) return Promise.resolve(false);
  const scope = `${current.userId}/${current.familyId}/${getCloudSessionEpoch()}`;
  if (inflightRefresh && inflightRefreshScope === scope) return inflightRefresh.then(() => true);
  if (lastRefreshScope === scope && Date.now() - lastRefreshAt < maxAgeMs) return Promise.resolve(false);
  const request = refreshCloud()
    .then(() => { lastRefreshAt = Date.now(); lastRefreshScope = scope; })
    .finally(() => { if (inflightRefresh === request) { inflightRefresh = null; inflightRefreshScope = ''; } });
  inflightRefresh = request;
  inflightRefreshScope = scope;
  return request.then(() => true);
}
export async function connectCloud(): Promise<{ user: { id: string; nickname: string }; families: Family[] }> {
  const before = getCloudSession();
  const epoch = getCloudSessionEpoch();
  const user = await callCloud<{ id: string; nickname: string }>('auth.login');
  const families = await callCloud<Family[]>('family.list');
  const previous = getCloudSession();
  if (previous?.userId !== before?.userId || previous?.familyId !== before?.familyId || epoch !== getCloudSessionEpoch()) {
    throw new CloudError('SESSION_CHANGED', '账号或家庭已切换，请重试');
  }
  const selected = families.find((f) => previous?.userId === user.id && previous.familyId === f.id) || families[0];
  reconcileFamilyState(user.id, families.map((f) => f.id));
  // Never inherit another WeChat identity's cache.
  setCloudSession({ userId: user.id, familyId: selected?.id || '' });
  return { user, families };
}
export async function selectFamily(familyId: string): Promise<void> {
  const previous = getCloudSession();
  if (!previous) throw new CloudError('UNAUTHENTICATED', '请先登录');
  setCloudSession({ userId: previous.userId, familyId });
  const epoch = getCloudSessionEpoch();
  try { await refreshCloud(); } catch (err) {
    const current = getCloudSession();
    if (current?.userId === previous.userId && epoch === getCloudSessionEpoch()
      && (current.familyId === familyId || !current.familyId)) setCloudSession(previous);
    throw err;
  }
}
export async function savePet(input: Partial<Pet> & { name: string; species: string; clientId?: string }): Promise<Pet> {
  const s = session();
  const old = input.id ? local.getPets().find((p) => p.id === input.id) : null;
  // 头像：本机路径先上传为云端 fileId；已上传过的临时链接走 mediaMap 反查，不会重复传
  let avatarId = '';
  if (input.avatar) {
    avatarId = input.avatar.indexOf('cloud://') === 0 ? input.avatar : (await uploadPhotos([input.avatar], s))[0];
    sameSession(s);
  }
  const pet = await callCloud<Pet>('pet.save', { ...input, id: input.id || undefined, ...(input.avatar !== undefined ? { avatar: avatarId } : {}), familyId: s.familyId, version: old?.version, clientId: input.clientId || uid() });
  sameSession(s);
  const savedAvatar = pet.avatar || '';
  const urls = savedAvatar ? await mapUrls([savedAvatar], s) : {};
  sameSession(s);
  const cached: Pet = { ...pet, avatar: savedAvatar ? (urls[savedAvatar] || '') : '' };
  cacheCloudData(local.getPets().filter((p) => p.id !== pet.id).concat(cached), local.getRecords());
  return cached;
}
export async function removePet(id: string): Promise<void> {
  const s = session();
  const pet = local.getPets().find((p) => p.id === id);
  await callCloud('pet.delete', { id, familyId: s.familyId, version: pet?.version });
  sameSession(s);
  cacheCloudData(local.getPets().filter((p) => p.id !== id), local.getRecords().filter((r) => r.petId !== id));
}
export async function addRecord(input: { petId: string; date: string; text: string; tags: string[]; photos: string[]; rawInput?: RawInput; mode?: string; clientId?: string; observe?: TraceObserver }): Promise<DiaryRecord> {
  const s = session();
  const raw = input.rawInput || { text: input.text, photos: input.photos, provenance: 'direct' };
  const photos = await uploadPhotos(input.photos, s, input.observe);
  const originalPhotos = await uploadPhotos(raw.photos, s, input.observe);
  sameSession(s);
  const d = await callCloud<CloudDiary>('diary.save', { familyId: s.familyId, petId: input.petId, clientId: input.clientId || uid(),
    formatted: { date: input.date, text: input.text, tags: input.tags, photos }, rawInput: { ...raw, photos: originalPhotos }, mode: input.mode });
  sameSession(s);
  const rec = hydrate(d, await mapUrls(d.formatted.photos, s));
  cacheCloudData(local.getPets(), local.getRecords().filter((r) => r.id !== rec.id).concat(rec));
  return rec;
}
export async function updateRecord(id: string, patch: Partial<DiaryRecord>): Promise<DiaryRecord | null> {
  const old = local.getRecord(id);
  if (!old) throw new Error('记录不存在，请刷新');
  const s = session();
  const value = { ...old, ...patch };
  const photos = await uploadPhotos(value.photos, s);
  sameSession(s);
  const d = await callCloud<CloudDiary>('diary.save', { id, version: old.version, familyId: s.familyId, petId: value.petId,
    formatted: { date: value.date, text: value.text, tags: value.tags, photos }, mode: 'manual' });
  sameSession(s);
  const rec = hydrate(d, await mapUrls(d.formatted.photos, s));
  cacheCloudData(local.getPets(), local.getRecords().filter((r) => r.id !== id).concat(rec));
  return rec;
}
export async function removeRecord(id: string): Promise<void> {
  const s = session();
  const old = local.getRecord(id);
  await callCloud('diary.delete', { familyId: s.familyId, id, version: old?.version });
  sameSession(s);
  cacheCloudData(local.getPets(), local.getRecords().filter((r) => r.id !== id));
}

