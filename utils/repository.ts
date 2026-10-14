/** UI mutations are acknowledged by the server before updating the cloud cache. */
import * as local from './store';
import { Pet, DiaryRecord, RawInput, getCloudSession, setCloudSession, cacheCloudData, uid } from './store';
import { callCloud, CloudError } from './cloud';

export interface Family {
  id: string; name: string;
  members: Array<{ userId: string; role: 'owner' | 'member'; joinedAt: number }>;
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
  return s;
}
const sameSession = (s: local.CloudSession) => {
  const current = getCloudSession();
  if (!current || current.userId !== s.userId || current.familyId !== s.familyId) throw new CloudError('SESSION_CHANGED', '家庭空间已切换，请重试');
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
async function uploadPhotos(paths: string[], s: local.CloudSession): Promise<string[]> {
  const ids: string[] = [];
  for (const path of paths) {
    sameSession(s);
    const known = mediaMap(s)[path];
    if (known) { ids.push(known); continue; }
    if (path.indexOf('cloud://') === 0) { ids.push(path); continue; } // Server validates family ownership.
    if (/^https?:/.test(path)) throw new Error('照片链接已失效，请刷新后重试');
    const compressed: string = await new Promise((resolve) => wx.compressImage({ src: path, quality: 50,
      success: (r) => resolve(r.tempFilePath), fail: () => resolve(path) }));
    const base64: string = await new Promise((resolve, reject) => (wx.getFileSystemManager() as any).readFile({
      filePath: compressed, encoding: 'base64', success: (r: any) => resolve(r.data), fail: reject,
    }));
    if (base64.length > 1398104) throw new Error('照片压缩后仍超过 1MB，请选择较小的 JPG 或 PNG 照片');
    const result = await callCloud<{ fileId: string }>('media.upload', { familyId: s.familyId, base64 });
    sameSession(s);
    wx.setStorageSync(mediaKey(s), { ...mediaMap(s), [path]: result.fileId, [result.fileId]: result.fileId });
    ids.push(result.fileId);
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
  if (!getCloudSession()) return;
  const s = session();
  const revision = local.getCloudCacheRevision();
  try {
    const identity = await callCloud<{ id: string }>('auth.login');
    if (identity.id !== s.userId) throw new CloudError('UNAUTHENTICATED', '微信账号已变更，请重新连接云端');
    const pets = await allPages<Pet>('pet.list', { familyId: s.familyId });
    const diaries: CloudDiary[] = [];
    for (const pet of pets) diaries.push(...await allPages<CloudDiary>('diary.list', { familyId: s.familyId, petId: pet.id }));
    const urls = await mapUrls(diaries.flatMap((d) => d.formatted.photos), s);
    sameSession(s);
    if (local.getCloudCacheRevision() === revision) cacheCloudData(pets, diaries.map((d) => hydrate(d, urls)));
  } catch (error) {
    if (error instanceof CloudError && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)) {
      sameSession(s);
      local.clearAll();
    }
    throw error;
  }
}
export async function connectCloud(): Promise<{ user: { id: string; nickname: string }; families: Family[] }> {
  const user = await callCloud<{ id: string; nickname: string }>('auth.login');
  const families = await callCloud<Family[]>('family.list');
  const previous = getCloudSession();
  const selected = families.find((f) => previous?.userId === user.id && previous.familyId === f.id) || families[0];
  if (!selected) throw new Error('没有可用的家庭空间');
  // Never inherit another WeChat identity's cache.
  setCloudSession({ userId: user.id, familyId: selected.id });
  return { user, families };
}
export async function selectFamily(familyId: string): Promise<void> {
  const previous = session();
  setCloudSession({ userId: previous.userId, familyId });
  try { await refreshCloud(); } catch (err) {
    const current = getCloudSession();
    if (current?.userId === previous.userId && current.familyId === familyId) setCloudSession(previous);
    throw err;
  }
}
export async function savePet(input: Partial<Pet> & { name: string; species: string; clientId?: string }): Promise<Pet> {
  if (!getCloudSession()) return local.savePet(input);
  const s = session();
  const old = input.id ? local.getPets().find((p) => p.id === input.id) : null;
  const pet = await callCloud<Pet>('pet.save', { ...input, id: input.id || undefined, familyId: s.familyId, version: old?.version, clientId: input.clientId || uid() });
  sameSession(s);
  cacheCloudData(local.getPets().filter((p) => p.id !== pet.id).concat(pet), local.getRecords());
  return pet;
}
export async function removePet(id: string): Promise<void> {
  if (!getCloudSession()) return local.removePet(id);
  const s = session();
  const pet = local.getPets().find((p) => p.id === id);
  await callCloud('pet.delete', { id, familyId: s.familyId, version: pet?.version });
  sameSession(s);
  cacheCloudData(local.getPets().filter((p) => p.id !== id), local.getRecords().filter((r) => r.petId !== id));
}
export async function addRecord(input: { petId: string; date: string; text: string; tags: string[]; photos: string[]; rawInput?: RawInput; mode?: string; clientId?: string }): Promise<DiaryRecord> {
  if (!getCloudSession()) return local.addRecord(input);
  const s = session();
  const raw = input.rawInput || { text: input.text, photos: input.photos, provenance: 'direct' };
  const photos = await uploadPhotos(input.photos, s);
  const originalPhotos = await uploadPhotos(raw.photos, s);
  sameSession(s);
  const d = await callCloud<CloudDiary>('diary.save', { familyId: s.familyId, petId: input.petId, clientId: input.clientId || uid(),
    formatted: { date: input.date, text: input.text, tags: input.tags, photos }, rawInput: { ...raw, photos: originalPhotos }, mode: input.mode });
  sameSession(s);
  const rec = hydrate(d, await mapUrls(d.formatted.photos, s));
  cacheCloudData(local.getPets(), local.getRecords().filter((r) => r.id !== rec.id).concat(rec));
  return rec;
}
export async function updateRecord(id: string, patch: Partial<DiaryRecord>): Promise<DiaryRecord | null> {
  if (!getCloudSession()) return local.updateRecord(id, patch);
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
  if (!getCloudSession()) return local.removeRecord(id);
  const s = session();
  const old = local.getRecord(id);
  await callCloud('diary.delete', { familyId: s.familyId, id, version: old?.version });
  sameSession(s);
  cacheCloudData(local.getPets(), local.getRecords().filter((r) => r.id !== id));
}
/** Explicit, restartable migration. Local originals are retained; deterministic IDs avoid duplicates. */
export async function importLocalData(): Promise<number> {
  const s = session();
  const snapshot = local.getLocalData();
  let count = 0;
  for (const pet of snapshot.pets) {
    sameSession(s);
    const created = await callCloud<Pet>('pet.save', { familyId: s.familyId, clientId: `legacy-pet-${pet.id}`,
      name: pet.name, species: pet.species, breed: pet.breed, birthday: pet.birthday, avatarId: pet.avatarId });
    for (const rec of snapshot.records.filter((r) => r.petId === pet.id)) {
      sameSession(s);
      await addRecord({ ...rec, petId: created.id, clientId: `legacy-diary-${rec.id}`, mode: rec.formatting?.mode || 'legacy',
        rawInput: rec.rawInput || { text: rec.text, photos: rec.photos, provenance: 'legacy' } });
      count++;
    }
  }
  await refreshCloud();
  return count;
}
