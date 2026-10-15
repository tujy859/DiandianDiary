import * as local from '../../utils/store';
import * as repo from '../../utils/repository';
import { callCloud, CloudError } from '../../utils/cloud';
import { memoryDatabase } from './helpers/cloud-db';
const { createService } = require('../../cloudfunctions/diaryApi/service');
jest.mock('../../utils/cloud', () => ({
  ...jest.requireActual('../../utils/cloud'), callCloud: jest.fn(),
}));
const rpc = callCloud as jest.Mock;
let service: any;
let db: any;
let identity: string;
let failAction: string;
let baseRpc: (action: string, data?: any) => Promise<any>;

beforeEach(() => {
  (wx as any).clearStorageSync(); rpc.mockReset();
  db = memoryDatabase(); identity = 'alice'; failAction = '';
  let sequence = 0;
  service = createService({ db, storage: {
    uploadFile: async ({ cloudPath }: any) => ({ fileID: `cloud://env/${cloudPath}` }),
    getTempFileURL: async ({ fileList }: any) => ({ fileList: fileList.map((fileID: string) => ({ fileID, status: 0, tempFileURL: `https://signed.example/${fileID}` })) }),
  }, token: () => (++sequence).toString().padStart(48, 'a') });
  baseRpc = async (action, data = {}) => {
    if (action === failAction) throw new CloudError('NETWORK', '网络中断');
    try { return await service({ action, data }, { OPENID: identity, APPID: 'app' }); }
    catch (err: any) { throw new CloudError(err.code, err.message); }
  };
  rpc.mockImplementation(baseRpc);
});
const input = (petId: string) => ({ petId, date: '2026-10-12', text: '整理的洗澡记录', tags: ['洗澡'], photos: [],
  rawInput: { text: '今天早上给点点洗澡了，好乖', photos: [] }, clientId: 'draft-one', mode: 'tool' });

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
  wx.getFileSystemManager = () => ({ readFile: ({ success }: any) => success({ data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]).toString('base64') }) });
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
  wx.getFileSystemManager = () => ({ readFile: ({ success }: any) => success({ data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]).toString('base64') }) });
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
