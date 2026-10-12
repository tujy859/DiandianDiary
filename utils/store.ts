/** 本地数据层：宠物、日记记录、聊天消息、模型配置的持久化（本轮无后端，全部走 Storage） */

export interface Pet {
  id: string;
  name: string;
  species: string; // 猫 / 狗 / 其他
  breed?: string;
  birthday?: string;
  createdAt: number;
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
}

export interface Draft {
  key: string;
  petId: string;
  date: string | null;
  text: string;
  tags: string[];
  photos: string[];
  status: 'pending' | 'saved' | 'failed' | 'discarded';
  recordId?: string;
}

export interface RefInfo {
  recordId: string;
  label: string;
  sub: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  kind: 'text' | 'draft' | 'query';
  text?: string;
  photos?: string[];
  draft?: Draft;
  refs?: RefInfo[];
  action?: string; // 'draft-from'：手动“记一下”
  sourceText?: string;
  demo?: boolean; // 本地演示规则生成
  mode?: 'local' | 'model' | 'tool'; // 本条回复的产生方式
  retry?: boolean; // 调用失败，可重试
  time: number;
}

const PETS_KEY = 'jd_pets';
const RECORDS_KEY = 'jd_records';
const MSGS_PREFIX = 'jd_messages_';
const MSGS_LEGACY_KEY = 'jd_messages';
const CUR_KEY = 'jd_current_pet';
const MODEL_KEY = 'jd_model_config';

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v === undefined || v === null ? fallback : (v as T);
  } catch (e) {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  wx.setStorageSync(key, value);
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

export function petEmoji(species: string): string {
  if (species === '猫') return '🐱';
  if (species === '狗') return '🐶';
  return '🐾';
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

export function addRecord(input: { petId: string; date: string; text: string; tags: string[]; photos: string[] }): DiaryRecord {
  const all = read<DiaryRecord[]>(RECORDS_KEY, []);
  const rec: DiaryRecord = {
    id: uid(),
    petId: input.petId,
    date: input.date,
    text: input.text || '',
    tags: input.tags || [],
    photos: input.photos || [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  all.push(rec);
  write(RECORDS_KEY, all);
  return rec;
}

export function updateRecord(id: string, patch: Partial<DiaryRecord>): DiaryRecord | null {
  const all = read<DiaryRecord[]>(RECORDS_KEY, []);
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch, id, updatedAt: Date.now() };
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
  wx.removeStorageSync(MSGS_LEGACY_KEY);
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

export function clearAll(): void {
  getPets().forEach((p) => wx.removeStorageSync(`${MSGS_PREFIX}${p.id}`));
  [PETS_KEY, RECORDS_KEY, MSGS_LEGACY_KEY, CUR_KEY].forEach((k) => wx.removeStorageSync(k));
}

function getStorage(key: string): string {
  return read<string>(key, '');
}

/* ---------------- 照片持久化 ---------------- */

/** 压缩后转存：先压缩再落盘，控制本机占用（压缩失败则用原图） */
function compressPhoto(p: string): Promise<string> {
  if (p.indexOf(wx.env.USER_DATA_PATH) === 0 || p.indexOf('http') === 0) return Promise.resolve(p);
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
      if (p.indexOf(wx.env.USER_DATA_PATH) === 0 || p.indexOf('http') === 0) return p;
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
