/** 本机退出与真实业务服务联测；微信身份、云数据均为内存演示数据。 */
import Dialog from 'tdesign-miniprogram/dialog/index';
import { logoutLocal } from '../../utils/family-state';
import * as store from '../../utils/store';
import * as repo from '../../utils/repository';
import { callCloud, CloudError } from '../../utils/cloud';
import { pendingStep } from '../../utils/onboard';
import { newSession, pushSession, saveLocalSession } from '../../utils/chat-store';
import { enableDeveloperMode } from '../../utils/developer';
import { enterEmptyTestFamily, getNewUserTestState } from '../../utils/new-user-test';
import { memoryDatabase } from './helpers/cloud-db';
const { createService } = require('../../cloudfunctions/diaryApi/service');
jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { confirm: jest.fn() } }), { virtual: true });
jest.mock('../../utils/cloud', () => ({ ...jest.requireActual('../../utils/cloud'), callCloud: jest.fn() }));
const rpc = callCloud as jest.Mock, confirm = Dialog.confirm as jest.Mock;
let db: any, definition: any, baseRpc: (action: string, data?: any) => Promise<any>;
const config = { provider: '自定义', baseUrl: 'https://model.example', apiKey: 'demo-key', model: 'demo' };
beforeAll(() => {
  (global as any).Page = (value: any) => { definition = value; };
  require('../../pages/family/family.ts');
});
beforeEach(async () => {
  jest.clearAllMocks(); wx.clearStorageSync(); db = memoryDatabase();
  const service = createService({ db, storage: {} });
  baseRpc = async (action, data = {}) => {
    try { return await service({ action, data }, { OPENID: 'demo', APPID: 'demo' }); }
    catch (err: any) { throw new CloudError(err.code, err.message); }
  };
  rpc.mockImplementation(baseRpc); confirm.mockReset().mockResolvedValue(undefined);
  jest.spyOn(wx, 'reLaunch').mockImplementation(() => {});
  await repo.connectCloud(); store.saveModelConfig(config);
});
afterEach(() => jest.restoreAllMocks());
function page() {
  const instance = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  instance.setData = (patch: any) => Object.assign(instance.data, patch);
  return instance;
}
function deferred() {
  let release!: () => void, started!: () => void;
  return { gate: new Promise<void>(resolve => { release = resolve; }), ready: new Promise<void>(resolve => { started = resolve; }),
    release: () => release(), started: () => started() };
}

test('退出清理当前账号全部家庭缓存 / 聊天 / 测试状态，保留其他账号和云端数据', async () => {
  const first = store.getCloudSession()!;
  const pet = await repo.savePet({ name: '原宠物', species: '猫' });
  await repo.addRecord({ petId: pet.id, date: '2025-10-01', text: '领养了小猫', tags: [], photos: [] });
  saveLocalSession(pet.id, newSession());
  enableDeveloperMode(); await enterEmptyTestFamily();
  await repo.savePet({ name: '测试宠物', species: '猫' });
  const otherKey = 'jd_cloud_other-user_other-family_jd_records';
  wx.setStorageSync(otherKey, ['其他账号的缓存']);
  wx.setStorageSync(`jd_media_${first.userId}_${first.familyId}`, { demo: 'photo-id' });
  const cloudBefore = JSON.stringify(['users', 'families', 'pets', 'diaries'].map(name => db.dump(name)));
  rpc.mockClear(); logoutLocal();
  expect(rpc).not.toHaveBeenCalled();
  expect(store.getCloudSession()).toBeNull();
  expect(pendingStep()).toBe('login');
  expect(wx.getStorageInfoSync().keys.some((key: string) => key.includes(first.userId))).toBe(false);
  expect(wx.getStorageSync(otherKey)).toEqual(['其他账号的缓存']);
  expect(store.getModelConfig()).toEqual(config);
  expect(JSON.stringify(['users', 'families', 'pets', 'diaries'].map(name => db.dump(name)))).toBe(cloudBefore);
  await repo.connectCloud(); await repo.refreshCloud();
  expect(store.getPets()[0].id).toBe(pet.id);
  expect(store.getRecords()).toHaveLength(1);
});

test('可选择清除模型配置，重复本机退出不改变云端家庭关系', () => {
  const cloudBefore = db.dump('users');
  logoutLocal(true); logoutLocal(true);
  expect(store.getCloudSession()).toBeNull();
  expect(store.getModelConfig().apiKey).toBe('');
  expect(db.dump('users')).toEqual(cloudBefore);
});

test('账号页取消保留登录和模型；确认退出回欢迎页并清除选中的模型配置', async () => {
  const family = page(); await family.onShow();
  family.onLogoutModelChange({ detail: { value: true } });
  const original = store.getCloudSession();
  confirm.mockRejectedValueOnce(new Error('取消'));
  await family.onLogout();
  expect(store.getCloudSession()).toEqual(original);
  expect(store.getModelConfig()).toEqual(config);
  expect(wx.reLaunch).not.toHaveBeenCalled();
  await family.onLogout();
  expect(confirm.mock.calls[1][0].content).toContain('本机模型配置也会清除');
  expect(store.getCloudSession()).toBeNull();
  expect(store.getModelConfig().apiKey).toBe('');
  expect(family.data).toMatchObject({ connected: false, loggedIn: false, families: [], members: [] });
  expect(wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/onboard/onboard' });
});

test('云端读取失败时仍可退出本机，不依赖网络，也支持已登录但无家庭', async () => {
  const family = page();
  rpc.mockRejectedValueOnce(new Error('网络不可用'));
  await family.onShow();
  expect(family.data).toMatchObject({ loggedIn: true, connected: false, busy: false });
  rpc.mockClear(); await family.onLogout();
  expect(rpc).not.toHaveBeenCalled();
  expect(store.getCloudSession()).toBeNull();
  store.setCloudSession({ userId: 'no-family-user', familyId: '' });
  await family.onLogout();
  expect(store.getCloudSession()).toBeNull();
});

test('退出时尚未返回的登录请求不能恢复登录状态', async () => {
  const wait = deferred();
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'family.list') { wait.started(); await wait.gate; }
    return result;
  });
  const pending = repo.connectCloud().catch(error => error);
  await wait.ready; logoutLocal(); wait.release();
  expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' });
  expect(store.getCloudSession()).toBeNull();
});

test('退出后重新登录相同账号和家庭，旧刷新不会复用或恢复清掉的缓存', async () => {
  const original = store.getCloudSession()!;
  await repo.savePet({ name: '旧请求宠物', species: '猫' });
  const wait = deferred(); let held = false;
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'pet.list' && !held) { held = true; wait.started(); await wait.gate; }
    return result;
  });
  const pending = repo.refreshCloudIfStale(0).catch(error => error);
  await wait.ready; logoutLocal(); await repo.connectCloud();
  expect(store.getCloudSession()).toEqual(original);
  expect(store.getPets()).toEqual([]);
  // 新登录刷新独立完成，不能等待 / 复用上一代正在等待的请求。
  await expect(repo.refreshCloudIfStale(0)).resolves.toBe(true);
  wait.release();
  expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' });
  expect(store.getPets()[0].name).toBe('旧请求宠物');
});

test('相同账号重新登录后，上一代聊天同步回包不能恢复本机当前会话', async () => {
  const pet = await repo.savePet({ name: '演示猫', species: '猫' });
  const session = newSession(); saveLocalSession(pet.id, session);
  const wait = deferred();
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'session.save') { wait.started(); await wait.gate; }
    return result;
  });
  const pending = pushSession(pet.id, session).catch(error => error);
  await wait.ready; logoutLocal(); await repo.connectCloud(); wait.release();
  expect((await pending).message).toContain('已切换');
  expect(wx.getStorageInfoSync().keys.some((key: string) => key.startsWith('jd_chat_'))).toBe(false);
});

test('退出后创建测试家庭的迟到响应不能恢复本机测试标记', async () => {
  enableDeveloperMode();
  const wait = deferred();
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'family.create') { wait.started(); await wait.gate; }
    return result;
  });
  const pending = enterEmptyTestFamily().catch(error => error);
  await wait.ready; logoutLocal(); await repo.connectCloud(); wait.release();
  expect((await pending).message).toContain('已切换');
  expect(getNewUserTestState()).toBeNull();
});
