/** 本地数据/云端读取缓存。云端写操作通过 repository 等待服务器确认。 */
import { isValidDate } from './date';

export interface Pet {
  id: string;
  name: string;
  species: string; // 猫 / 狗 / 其他
  breed?: string;
  birthday?: string;
  /** 可展示的头像：云端临时链接或本机持久路径；空则按物种用内置图标 */
  avatar?: string;
  createdAt: number;
  familyId?: string;
  version?: number;
}

export interface RawInput {
  text: string;
  photos: string[];
  provenance?: 'direct' | 'legacy';
}

export interface DiaryRecord {
  id: string;
  petId: string;
  date: string; // 事件发生日期 YYYY-MM-DD
  text: string;
  tags: string[];
  photos: string[];
  createdAt: number;
  updatedAt: number;
  rawInput?: RawInput;
  familyId?: string;
  version?: number;
  createdBy?: string;
  formatting?: { schemaVersion: number; mode: string };
}

export interface Draft {
  key: string;
  petId: string;
  date: string | null;
  text: string;
  tags: string[];
  photos: string[];
  /** 云端 fileId（会话同步后照片以此为准，photos 存的是可展示链接） */
  photoIds?: string[];
  status: 'pending' | 'saved' | 'failed' | 'discarded';
  recordId?: string;
  rawInput?: RawInput;
}

export interface RefInfo {
  recordId: string;
  label: string;
  sub: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  /** divider：话题分隔条，标记上下文边界（见 utils/context.ts），不参与 AI 对话历史 */
  kind: 'text' | 'draft' | 'query' | 'divider';
  text?: string;
  photos?: string[];
  photoIds?: string[];
  draft?: Draft;
  refs?: RefInfo[];
  action?: string; // 'draft-from'：手动“记一下”
  sourceText?: string;
  sourcePhotos?: string[]; // 重试使用原请求照片，不丢失图文上下文
  mode?: 'model' | 'tool' | 'manual'; // 本条回复的产生方式
  retry?: boolean; // 调用失败，可重试
  time: number;
}

const PETS_KEY = 'jd_pets';
const RECORDS_KEY = 'jd_records';
const MSGS_PREFIX = 'jd_messages_';
const MSGS_LEGACY_KEY = 'jd_messages';
const CUR_KEY = 'jd_current_pet';
const MODEL_KEY = 'jd_model_config';
const SESSION_KEY = 'jd_cloud_session';
export interface CloudSession { userId: string; familyId: string }
export function getCloudSession(): CloudSession | null { return wx.getStorageSync(SESSION_KEY) || null; }
export function setCloudSession(session: CloudSession | null): void {
  if (session) wx.setStorageSync(SESSION_KEY, session);
  else wx.removeStorageSync(SESSION_KEY);
}
function scopedKey(key: string): string {
  const session = getCloudSession();
  return session && key !== MODEL_KEY ? `jd_cloud_${session.userId}_${session.familyId}_${key}` : key;
}
/** Commit a complete fetched snapshot only after all pages and media resolve. */
export function cacheCloudData(pets: Pet[], records: DiaryRecord[]): void {
  if (!getCloudSession()) throw new Error('云端会话不存在');
  write(PETS_KEY, pets);
  write(RECORDS_KEY, records);
  write('jd_cache_revision', getCloudCacheRevision() + 1);
}
export function getCloudCacheRevision(): number { return read<number>('jd_cache_revision', 0); }
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = wx.getStorageSync(scopedKey(key));
    return v === '' || v === undefined || v === null ? fallback : (v as T);
  } catch (e) {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  wx.setStorageSync(scopedKey(key), value);
}

/* ---------------- 宠物 ---------------- */

export function getPets(): Pet[] {
  return read<Pet[]>(PETS_KEY, []);
}

export function savePet(pet: Partial<Pet> & { name: string; species: string }): Pet {
  const pets = getPets();
  if (pet.id) {
    const idx = pets.findIndex((p) => p.id === pet.id);
    if (idx >= 0) {
      pets[idx] = { ...pets[idx], ...pet } as Pet;
      write(PETS_KEY, pets);
      return pets[idx];
    }
  }
  const created: Pet = {
    id: uid(),
    name: pet.name.trim(),
    species: pet.species,
    breed: pet.breed || '',
    birthday: pet.birthday || '',
    avatar: pet.avatar || '',
    createdAt: Date.now(),
  };
  pets.push(created);
  write(PETS_KEY, pets);
  if (!getStorage(CUR_KEY)) setCurrentPet(created.id);
  return created;
}

export function removePet(id: string): void {
  write(PETS_KEY, getPets().filter((p) => p.id !== id));
  write(RECORDS_KEY, getRecords().filter((r) => r.petId !== id));
  if (getStorage(CUR_KEY) === id) {
    const rest = getPets();
    write(CUR_KEY, rest.length ? rest[0].id : '');
  }
}

export function getCurrentPet(): Pet | null {
  const pets = getPets();
  if (!pets.length) return null;
  const id = read<string>(CUR_KEY, '');
  return pets.find((p) => p.id === id) || pets[0];
}

export function setCurrentPet(id: string): void {
  write(CUR_KEY, id);
}

/** 宠物头像：自定义照片优先，否则按物种用内置品牌图标（assets/icons 由 tools/icons/build.js 生成） */
export function petAvatar(pet: Pet | null | undefined): string {
  if (pet && pet.avatar) return pet.avatar;
  const species = pet ? pet.species : '';
  if (species === '猫') return '/assets/icons/cat.png';
  if (species === '狗') return '/assets/icons/dog.png';
  return '/assets/icons/paw.png';
}

/* ---------------- 日记记录 ---------------- */

export function getRecords(petId?: string): DiaryRecord[] {
  const all = read<DiaryRecord[]>(RECORDS_KEY, []);
  const list = petId ? all.filter((r) => r.petId === petId) : all;
  return list.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1));
}

export function getRecord(id: string): DiaryRecord | null {
  return read<DiaryRecord[]>(RECORDS_KEY, []).find((r) => r.id === id) || null;
}

export function addRecord(input: { petId: string; date: string; text: string; tags: string[]; photos: string[]; rawInput?: RawInput; mode?: string }): DiaryRecord {
  if (!isValidDate(input.date)) throw new Error('记录日期无效');
  const all = read<DiaryRecord[]>(RECORDS_KEY, []);
  const rec: DiaryRecord = {
    id: uid(),
    petId: input.petId,
    date: input.date,
    text: input.text || '',
    tags: input.tags || [],
    photos: input.photos || [],
    rawInput: input.rawInput || { text: input.text || '', photos: (input.photos || []).slice(), provenance: 'direct' },
    formatting: { schemaVersion: 1, mode: input.mode || 'manual' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  all.push(rec);
  write(RECORDS_KEY, all);
  return rec;
}

export function updateRecord(id: string, patch: Partial<DiaryRecord>): DiaryRecord | null {
  if (patch.date !== undefined && !isValidDate(patch.date)) throw new Error('记录日期无效');
  const all = read<DiaryRecord[]>(RECORDS_KEY, []);
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch, rawInput: all[idx].rawInput, id, updatedAt: Date.now() };
  write(RECORDS_KEY, all);
  return all[idx];
}

export function removeRecord(id: string): void {
  write(RECORDS_KEY, read<DiaryRecord[]>(RECORDS_KEY, []).filter((r) => r.id !== id));
}

/* ---------------- 聊天消息（按宠物隔离） ---------------- */

/** 老版本是单线程消息，首次按宠物读取时迁移到当前宠物名下 */
function migrateLegacyMessages(petId: string): void {
  const legacy = read<ChatMessage[] | null>(MSGS_LEGACY_KEY, null);
  if (legacy && legacy.length && petId) {
    write(`${MSGS_PREFIX}${petId}`, legacy);
  }
  wx.removeStorageSync(scopedKey(MSGS_LEGACY_KEY));
}

export function getMessages(petId: string): ChatMessage[] {
  if (!petId) return [];
  migrateLegacyMessages(petId);
  return read<ChatMessage[]>(`${MSGS_PREFIX}${petId}`, []);
}

export function saveMessages(petId: string, msgs: ChatMessage[]): void {
  if (!petId) return;
  write(`${MSGS_PREFIX}${petId}`, msgs.slice(-200));
}

/* ---------------- 模型配置（占位） ---------------- */

export interface ModelConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function getModelConfig(): ModelConfig {
  return read<ModelConfig>(MODEL_KEY, { provider: '', baseUrl: '', apiKey: '', model: '' });
}

export function saveModelConfig(cfg: ModelConfig): void {
  write(MODEL_KEY, cfg);
}

/** 单独清除模型配置（API Key 等敏感凭证），与"清除全部数据"互不影响 */
export function clearModelConfig(): void {
  wx.removeStorageSync(MODEL_KEY);
}

export function clearAll(): void {
  const session = getCloudSession();
  if (session) {
    write('jd_cache_revision', getCloudCacheRevision() + 1);
    wx.removeStorageSync(`jd_media_${session.userId}_${session.familyId}`);
  }
  getPets().forEach((p) => wx.removeStorageSync(scopedKey(`${MSGS_PREFIX}${p.id}`)));
  [PETS_KEY, RECORDS_KEY, MSGS_LEGACY_KEY, CUR_KEY].forEach((k) => wx.removeStorageSync(scopedKey(k)));
}

function getStorage(key: string): string {
  return read<string>(key, '');
}

/* ---------------- 照片持久化 ---------------- */

/** 压缩后转存：先压缩再落盘，控制本机占用（压缩失败则用原图） */
function compressPhoto(p: string): Promise<string> {
  if (p.indexOf(wx.env.USER_DATA_PATH) === 0 || p.indexOf('http') === 0 || p.indexOf('cloud://') === 0) return Promise.resolve(p);
  return new Promise((resolve) => {
    wx.compressImage({
      src: p,
      quality: 70,
      success: (res) => resolve(res.tempFilePath || p),
      fail: () => resolve(p),
    });
  });
}

/** 把 chooseMedia 的临时路径转存到用户目录，返回可长期使用的路径；已经是持久路径的原样返回 */
export function persistPhotos(paths: string[]): Promise<string[]> {
  const fs = wx.getFileSystemManager();
  const dir = `${wx.env.USER_DATA_PATH}/photos`;
  try {
    fs.accessSync(dir);
  } catch (e) {
    try {
      fs.mkdirSync(dir, true);
    } catch (e2) { /* 已存在则忽略 */ }
  }
  return Promise.all(
    paths.map(async (p, i) => {
      if (p.indexOf(wx.env.USER_DATA_PATH) === 0 || p.indexOf('http') === 0 || p.indexOf('cloud://') === 0) return p;
      const src = await compressPhoto(p);
      const filePath = `${dir}/p_${Date.now()}_${i}_${Math.floor(Math.random() * 1e6)}.jpg`;
      return new Promise<string>((resolve, reject) => {
        fs.saveFile({
          tempFilePath: src,
          filePath,
          success: (res) => resolve(res.savedFilePath || filePath),
          fail: reject,
        });
      });
    }),
  );
}
