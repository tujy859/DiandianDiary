import * as local from '../../utils/store';
import * as repo from '../../utils/repository';
import { callCloud, CloudError } from '../../utils/cloud';
import { memoryDatabase } from './helpers/cloud-db';
import { validateDraft } from '../../utils/draft';
import { enableDeveloperMode } from '../../utils/developer';
import { setTraceEnabled, getDebugTraces } from '../../utils/debug-trace';
const { createService } = require('../../cloudfunctions/diaryApi/service');
jest.mock('tdesign-miniprogram/action-sheet/index', () => ({ __esModule: true, default: { show: jest.fn() } }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { confirm: jest.fn() } }), { virtual: true });
jest.mock('../../utils/cloud', () => ({
  ...jest.requireActual('../../utils/cloud'), callCloud: jest.fn(),
}));
const rpc = callCloud as jest.Mock;
let service: any;
let db: any;
let identity: string;
let failAction: string;
let baseRpc: (action: string, data?: any) => Promise<any>;
let mediaFiles: Map<string, Buffer>;

beforeEach(() => {
  (wx as any).clearStorageSync(); rpc.mockReset();
  db = memoryDatabase(); identity = 'alice'; failAction = '';
  mediaFiles = new Map();
  jest.spyOn(wx, 'request').mockImplementation((options: any) => {
    mediaFiles.set(`cloud://env/${options.url.slice('https://upload.example/'.length)}`, Buffer.from(options.data));
    options.success({ statusCode: 200 });
  });
  let sequence = 0;
  service = createService({ db, storage: {
    uploadFile: async ({ cloudPath, fileContent }: any) => {
      const fileID = `cloud://env/${cloudPath}`;
      mediaFiles.set(fileID, Buffer.from(fileContent));
      return { fileID };
    },
    prepareUpload: async (cloudPath: string) => ({ fileId: `cloud://env/${cloudPath}`, url: `https://upload.example/${cloudPath}`, headers: {} }),
    downloadFile: async ({ fileID }: any) => ({ fileContent: mediaFiles.get(fileID) }),
    deleteFile: async ({ fileList }: any) => { fileList.forEach((id: string) => mediaFiles.delete(id)); },
    getTempFileURL: async ({ fileList }: any) => ({ fileList: fileList.map((fileID: string) => ({ fileID, status: 0, tempFileURL: `https://signed.example/${fileID}` })) }),
  }, token: () => (++sequence).toString().padStart(48, 'a') });
  baseRpc = async (action, data = {}) => {
    if (action === failAction) throw new CloudError('NETWORK', '网络中断');
    try { return await service({ action, data }, { OPENID: identity, APPID: 'app' }); }
    catch (err: any) { throw new CloudError(err.code, err.message); }
  };
  rpc.mockImplementation(baseRpc);
});
afterEach(() => jest.restoreAllMocks());

describe('从聊天选图到确认保存', () => {
  let chatDefinition: any;
  beforeAll(() => {
    (global as any).Page = (definition: any) => { chatDefinition = definition; };
    require('../../pages/chat/chat.ts');
  });
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
  test.each([800 * 1024, 3 * 1024 * 1024])('聊天接受的 %i 字节照片能够原样保存，确认前不上云', async size => {
    const bytes = new Uint8Array(size); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const source = 'wxfile://tmp/private-photo.png';
    const save = jest.fn(({ filePath, success }) => success({ savedFilePath: filePath }));
    jest.spyOn(wx, 'getFileSystemManager').mockReturnValue({ accessSync: () => undefined, saveFile: save,
      readFile: ({ success }: any) => success({ data: bytes.buffer }) });
    const compress = jest.spyOn(wx, 'compressImage');
    jest.spyOn(wx, 'chooseMedia').mockImplementation((options: any) => options.success({ tempFiles: [{ tempFilePath: source, size }] }));
    await repo.connectCloud(); const pet = await repo.savePet({ name: '演示猫', species: '猫' });
    enableDeveloperMode(); setTraceEnabled(true);
    const page: any = { ...chatDefinition, data: JSON.parse(JSON.stringify(chatDefinition.data)),
      _syncTail: Promise.resolve(), _scopeEpoch: local.getCloudSessionEpoch(), syncSession: jest.fn() };
    page.setData = (patch: any) => Object.entries(patch).forEach(([key, value]) => {
      const match = key.match(/^messages\[(\d+)\]\.draft$/);
      if (match) page.data.messages[Number(match[1])].draft = value;
      else page.data[key] = value;
    });
    page.data.currentPet = pet;
    page.onChoosePhoto();
    expect(page.data.attachments).toEqual([source]);
    await page.onSend();
    expect(db.dump('diaries')).toHaveLength(0);
    expect(rpc.mock.calls.some(([action]) => action === 'media.prepare')).toBe(false);
    const draft = page.data.messages.find((message: any) => message.draft).draft;
    page.onCardSetDate({ detail: { key: draft.key, date: '2026-10-15' } });
    await page.onCardSave({ detail: { key: draft.key } });
    expect(page.data.messages.find((message: any) => message.draft).draft.status).toBe('saved');
    const record = db.dump('diaries')[0];
    expect(mediaFiles.get(record.formatted.photos[0])!.equals(Buffer.from(bytes))).toBe(true);
    expect(record.rawInput.photos).toEqual(record.formatted.photos);
    expect(compress).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    const events = getDebugTraces()[0].events;
    expect(events.find(event => event.phase === 'photo.upload')!.detail).toEqual({ photoIndex: 0, sourceBytes: size, uploadBytes: size });
    expect(events.some(event => event.phase === 'photo.complete')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private-photo');
  });
});
const input = (petId: string) => ({ petId, date: '2026-10-12', text: '整理的洗澡记录', tags: ['洗澡'], photos: [],
  rawInput: { text: '今天早上给点点洗澡了，好乖', photos: [] }, clientId: 'draft-one', mode: 'tool' });

test('原文两位年份从草稿到云端保存和重新读取均保留为 2025', async () => {
  await repo.connectCloud();
  const pet = await repo.savePet({ name: '测试咪2号', species: '猫' });
  const text = '25年10月1日，领养了小猫';
  const draft = validateDraft({ text: '领养了小猫', sourceText: text, date: '2026-10-01' },
    { text, petId: pet.id, photos: [] }, '2026-10-15');
  const saved = await repo.addRecord({ ...draft, date: draft.date!, clientId: 'year-regression' });
  expect(db.dump('diaries')[0].formatted.date).toBe('2025-10-01');
  local.clearAll(); await repo.refreshCloud();
  expect(local.getRecord(saved.id)).toMatchObject({ date: '2025-10-01', rawInput: { text } });
});

test('切换家庭后的节流刷新不复用旧家庭正在等待的请求', async () => {
  await repo.connectCloud();
  const previous = local.getCloudSession()!;
  const next = await callCloud<repo.Family>('family.create', { name: '新测试家庭', clientId: 'new-user-test-refresh' });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  let wait = true;
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'pet.list' && data.familyId === previous.familyId && wait) { wait = false; started(); await gate; }
    return result;
  });
  const stale = repo.refreshCloudIfStale(0).catch(error => error);
  await ready;
  local.setCloudSession({ userId: previous.userId, familyId: next.id });
  try {
    // 新家庭刷新须独立完成，不能等待上一个家庭的请求。
    await expect(repo.refreshCloudIfStale(0)).resolves.toBe(true);
    expect(local.getCloudSession()!.familyId).toBe(next.id);
  } finally { release(); }
  expect(await stale).toMatchObject({ code: 'SESSION_CHANGED' });
});

test('未登录不能写入本机；连接云端后按账号和家庭隔离缓存', async () => {
  await expect(repo.savePet({ name: '本机猫', species: '猫' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  await repo.connectCloud();
  const pet = await repo.savePet({ name: '云端猫', species: '猫' });
  await repo.addRecord(input(pet.id));
  expect(local.getRecords()[0].rawInput!.text).toContain('今天早上');
  const a = local.getCloudSession()!;
  identity = 'bob';
  await repo.connectCloud(); await repo.refreshCloud();
  expect(local.getCloudSession()!.userId).not.toBe(a.userId);
  expect(local.getPets()).toHaveLength(0);
});

test('云端写失败不显示已保存，不回退为本地记录', async () => {
  await repo.connectCloud();
  const pet = await repo.savePet({ name: '点点', species: '猫' });
  failAction = 'diary.save';
  await expect(repo.addRecord(input(pet.id))).rejects.toMatchObject({ code: 'NETWORK' });
  expect(local.getRecords()).toHaveLength(0);
});

test('服务端已提交但响应丢失，原草稿重试不会重复创建', async () => {
  await repo.connectCloud(); const pet = await repo.savePet({ name: '点点', species: '猫' });
  let lost = true;
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'diary.save' && lost) { lost = false; throw new CloudError('NETWORK', '响应丢失'); }
    return result;
  });
  await expect(repo.addRecord(input(pet.id))).rejects.toThrow('响应丢失');
  await repo.addRecord(input(pet.id));
  expect(db.dump('diaries')).toHaveLength(1);
  expect(local.getRecords()).toHaveLength(1);
});

test('切换家庭后迟到的刷新不能覆盖新家庭缓存', async () => {
  await repo.connectCloud();
  await repo.savePet({ name: 'A猫', species: '猫' });
  const next = await callCloud<repo.Family>('family.create', { name: 'B家', clientId: 'b' });
  let release: () => void = () => {};
  let started: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let wait = true;
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'pet.list' && wait) { wait = false; started(); await gate; }
    return result;
  });
  const stale = repo.refreshCloud(); const observed = stale.catch((e) => e);
  await ready;
  await repo.selectFamily(next.id);
  await repo.savePet({ name: 'B猫', species: '猫' });
  release();
  expect((await observed).code).toBe('SESSION_CHANGED');
  expect(local.getPets().map((p) => p.name)).toEqual(['B猫']);
});

test('同一家庭迟到刷新不覆盖刚确认的云端写入', async () => {
  await repo.connectCloud();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'pet.list') { started(); await gate; }
    return result;
  });
  const stale = repo.refreshCloud();
  await ready;
  await repo.savePet({ name: '新猫', species: '猫' });
  release(); await stale;
  expect(local.getPets()[0].name).toBe('新猫');
});

test('微信身份变化或权限失效清空当前缓存，保留云端模式防止静默写到本机', async () => {
  await repo.connectCloud(); await repo.savePet({ name: 'A猫', species: '猫' });
  identity = 'bob';
  await expect(repo.refreshCloud()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  expect(local.getPets()).toHaveLength(0);
  expect(local.getCloudSession()).not.toBeNull();
  await expect(repo.savePet({ name: '错误的猫', species: '猫' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(local.getPets()).toHaveLength(0);
});

test('清除云端缓存保留服务端数据，刷新可恢复', async () => {
  await repo.connectCloud(); await repo.savePet({ name: '云猫', species: '猫' });
  local.clearAll(); expect(local.getPets()).toHaveLength(0);
  await repo.refreshCloud(); expect(local.getPets()[0].name).toBe('云猫');
});

test('照片从本机上传为私有 fileID；编辑签名链接映射回原文件并保留原始照片', async () => {
  const oldFs = wx.getFileSystemManager;
  wx.getFileSystemManager = () => ({ readFile: ({ success }: any) => success({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]).buffer }) });
  try {
    await repo.connectCloud(); const pet = await repo.savePet({ name: '点点', species: '猫' });
    const data = { ...input(pet.id), photos: ['/local/photo.jpg'], rawInput: { text: '原始照片输入', photos: ['/local/photo.jpg'] } };
    const record = await repo.addRecord(data);
    expect(record.photos[0]).toMatch(/^https:\/\/signed/);
    expect(record.rawInput!.photos[0]).toMatch(/^cloud:\/\//);
    expect(db.dump('media')).toHaveLength(1);
    await repo.updateRecord(record.id, { text: '改后', photos: record.photos });
    expect(db.dump('diaries')[0].formatted.photos[0]).toMatch(/^cloud:\/\//);
    await repo.updateRecord(record.id, { photos: [] });
    expect(local.getRecord(record.id)!.rawInput!.photos).toHaveLength(1);
    expect(db.dump('diaries')[0].formatted.photos).toHaveLength(0);
  } finally { wx.getFileSystemManager = oldFs; }
});

test('云端版本冲突不覆盖本机已读取记录；刷新后可以重新编辑', async () => {
  await repo.connectCloud(); const pet = await repo.savePet({ name: '点点', species: '猫' });
  const first = await repo.addRecord(input(pet.id));
  await callCloud('diary.save', { familyId: first.familyId, petId: pet.id, id: first.id, version: 1,
    formatted: { date: first.date, text: '另一台设备修改', tags: [], photos: [] } });
  await expect(repo.updateRecord(first.id, { text: '本机旧版本' })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(local.getRecord(first.id)!.text).toBe(first.text);
  await repo.refreshCloud();
  expect(local.getRecord(first.id)!.text).toBe('另一台设备修改');
  await repo.updateRecord(first.id, { text: '合并后的内容' });
  expect(local.getRecord(first.id)!.version).toBe(3);
});

test('超过 1MB 的选图原样上传并保存；原始输入复用同一照片，不再次压缩', async () => {
  const photo = new Uint8Array(3 * 1024 * 1024);
  photo.set([0xff, 0xd8, 0xff, 0xe0]);
  photo[photo.length - 1] = 42;
  const compress = jest.spyOn(wx, 'compressImage');
  const fs = jest.spyOn(wx, 'getFileSystemManager').mockReturnValue({ readFile: ({ success }: any) => success({ data: photo.buffer }) });
  try {
    await repo.connectCloud(); const pet = await repo.savePet({ name: '点点', species: '猫' });
    const saved = await repo.addRecord({ ...input(pet.id), photos: ['/local/large.jpg'],
      rawInput: { text: '演示照片', photos: ['/local/large.jpg'] } });
    expect(mediaFiles.get(saved.rawInput!.photos[0])!.equals(Buffer.from(photo))).toBe(true);
    expect(wx.request).toHaveBeenCalledTimes(1);
    expect((wx.request as jest.Mock).mock.calls[0][0].method).toBe('PUT');
    expect((wx.request as jest.Mock).mock.calls[0][0].data).toBe(photo.buffer);
    expect(compress).not.toHaveBeenCalled();
    expect(rpc.mock.calls.some(([action]) => action === 'media.upload')).toBe(false);
    expect(db.dump('diaries')).toHaveLength(1);
    expect(db.dump('media')).toHaveLength(1);
  } finally { fs.mockRestore(); }
});

test('照片直传失败时不确认上传、不写日记，重试可以完成', async () => {
  const fs = jest.spyOn(wx, 'getFileSystemManager').mockReturnValue({ readFile: ({ success }: any) => success({ data: new Uint8Array([255, 216, 255]).buffer }) });
  try {
    await repo.connectCloud(); const pet = await repo.savePet({ name: '点点', species: '猫' });
    (wx.request as jest.Mock).mockImplementationOnce((options) => options.success({ statusCode: 403, data: 'private response' }));
    const data = { ...input(pet.id), photos: ['/local/photo.jpg'] };
    await expect(repo.addRecord(data)).rejects.toThrow('照片上传失败，请重试');
    expect(rpc.mock.calls.some(([action]) => action === 'media.complete')).toBe(false);
    expect(db.dump('diaries')).toHaveLength(0);
    expect(db.dump('media')).toHaveLength(0);
    await expect(repo.addRecord(data)).resolves.toHaveProperty('id');
  } finally { fs.mockRestore(); }
});

test('照片传输期间退出登录，迟到成功不能继续确认或保存', async () => {
  const fs = jest.spyOn(wx, 'getFileSystemManager').mockReturnValue({ readFile: ({ success }: any) => success({ data: new Uint8Array([255, 216, 255]).buffer }) });
  try {
    await repo.connectCloud(); const pet = await repo.savePet({ name: '点点', species: '猫' });
    (wx.request as jest.Mock).mockImplementationOnce((options) => { local.setCloudSession(null); options.success({ statusCode: 200 }); });
    await expect(repo.addRecord({ ...input(pet.id), photos: ['/local/photo.jpg'] })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(rpc.mock.calls.some(([action]) => action === 'media.complete')).toBe(false);
    expect(db.dump('diaries')).toHaveLength(0);
  } finally { fs.mockRestore(); }
});

test('云端头像跨刷新保留，旧客户端编辑不清空头像，拒绝跨物种或任意路径', async () => {
  await repo.connectCloud();
  const pet = await repo.savePet({ name: '点点', species: '猫', avatarId: 'cat-british-longhair-gray' });
  await repo.refreshCloud();
  expect(local.getPets()[0].avatarId).toBe('cat-british-longhair-gray');
  await repo.savePet({ id: pet.id, name: '点点改名', species: '猫' });
  expect(local.getPets()[0].avatarId).toBe('cat-british-longhair-gray');
  await expect(repo.savePet({ id: pet.id, name: '点点', species: '猫', avatarId: 'dog-cream' })).rejects.toMatchObject({ code: 'INVALID' });
  await expect(repo.savePet({ id: pet.id, name: '点点', species: '猫', avatarId: '/assets/anything.png' })).rejects.toMatchObject({ code: 'INVALID' });
});

test('上传头像在改名和刷新后保留，内置头像选择不破坏原照片', async () => {
  const oldFs = wx.getFileSystemManager;
  wx.getFileSystemManager = () => ({ readFile: ({ success }: any) => success({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]).buffer }) });
  try {
    await repo.connectCloud();
    const pet = await repo.savePet({ name: '点点', species: '猫', avatar: '/local/avatar.jpg' });
    expect(pet.avatar).toMatch(/^https:\/\/signed/);
    await repo.savePet({ id: pet.id, name: '点点改名', species: '猫' });
    await repo.refreshCloud();
    expect(local.getPets()[0].avatar).toBe(pet.avatar);
    await repo.savePet({ id: pet.id, name: '点点', species: '猫', avatarId: 'cat-british-longhair-gray' });
    expect(local.getPets()[0].avatarId).toBe('cat-british-longhair-gray');
    expect(local.getPets()[0].avatar).toBe(pet.avatar);
    expect(db.dump('media')).toHaveLength(1);
  } finally { wx.getFileSystemManager = oldFs; }
});
