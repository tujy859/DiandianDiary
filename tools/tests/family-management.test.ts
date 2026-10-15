/** 页面、客户端缓存和真实业务服务联测；不连接实际云环境。 */
import Dialog from 'tdesign-miniprogram/dialog/index';
import * as store from '../../utils/store';
import * as repo from '../../utils/repository';
import { callCloud, CloudError } from '../../utils/cloud';
import { guardReady } from '../../utils/onboard';
import { enableDeveloperMode } from '../../utils/developer';
import { enterEmptyTestFamily, getNewUserTestState, returnToOriginalFamily } from '../../utils/new-user-test';
import { loadLocalSession, newSession, saveLocalSession } from '../../utils/chat-store';
import { memoryDatabase } from './helpers/cloud-db';
const { createService } = require('../../cloudfunctions/diaryApi/service');
jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { confirm: jest.fn() } }), { virtual: true });
jest.mock('../../utils/cloud', () => ({ ...jest.requireActual('../../utils/cloud'), callCloud: jest.fn() }));
const rpc = callCloud as jest.Mock;
const confirm = Dialog.confirm as jest.Mock;
let definition: any, service: any, db: any, identity: string;
const config = { provider: '自定义', baseUrl: 'https://model.example', apiKey: 'demo-key', model: 'demo' };
beforeAll(() => {
  (global as any).Page = (value: any) => { definition = value; };
  require('../../pages/family/family.ts');
});
beforeEach(async () => {
  jest.clearAllMocks(); wx.clearStorageSync();
  db = memoryDatabase(); identity = 'alice';
  let sequence = 0;
  service = createService({ db, storage: {}, token: () => (++sequence).toString().padStart(48, 'a') });
  rpc.mockImplementation(async (action, data = {}) => {
    try { return await service({ action, data }, { OPENID: identity, APPID: 'demo' }); }
    catch (err: any) { throw new CloudError(err.code, err.message); }
  });
  confirm.mockReset().mockResolvedValue(undefined);
  jest.spyOn(wx, 'reLaunch').mockImplementation(() => {});
  jest.spyOn(wx, 'navigateTo').mockImplementation(() => {});
  await repo.connectCloud();
  store.saveModelConfig(config);
});
afterEach(() => jest.restoreAllMocks());
function page() {
  const instance = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  instance.setData = (patch: any) => Object.assign(instance.data, patch);
  return instance;
}

test('解散测试家庭后清理其缓存和测试标记，恢复原家庭与模型配置', async () => {
  const original = store.getCloudSession()!;
  const originalPet = await repo.savePet({ name: '原家庭宠物', species: '猫' });
  enableDeveloperMode(); await enterEmptyTestFamily();
  const test = store.getCloudSession()!;
  const testPet = await repo.savePet({ name: '测试宠物', species: '猫' });
  saveLocalSession(testPet.id, newSession());
  const family = page(); await family.onShow();
  await family.onDissolve();
  expect(store.getCloudSession()).toEqual({ userId: original.userId, familyId: '' });
  expect(wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/family/family' });
  expect(wx.getStorageInfoSync().keys.some((key: string) => key.includes(test.familyId))).toBe(false);
  expect(getNewUserTestState()).toMatchObject({ originalFamilyId: original.familyId, testFamilyId: '' });
  const fresh = page(); await fresh.onShow();
  expect(store.getCloudSession()).toEqual(original);
  expect(store.getPets().map(pet => pet.id)).toEqual([originalPet.id]);
  expect(store.getModelConfig()).toEqual(config);
  expect(db.dump('pets').some((pet: any) => pet._id === testPet.id)).toBe(true);
});

test('解散最后一个家庭进入已登录空状态，守卫进入家庭页，能重新创建家庭', async () => {
  const family = page(); await family.onShow();
  await family.onDissolve();
  const fresh = page(); await fresh.onShow();
  expect(fresh.data).toMatchObject({ connected: true, families: [], members: [], familyId: '', owner: false });
  expect(store.getCloudSession()).not.toBeNull();
  expect(guardReady()).toBe(false);
  expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/family/family' });
  await expect(repo.savePet({ name: '不可写入空家庭', species: '猫' })).rejects.toMatchObject({ code: 'NO_FAMILY' });
  fresh.data.familyName = '重新开始';
  await fresh.onCreate();
  expect(fresh.data.families).toHaveLength(1);
  expect(fresh.data.selectedFamilyName).toBe('重新开始');
  expect(fresh.data.owner).toBe(true);
  expect(store.getModelConfig()).toEqual(config);
});

test('取消解散、确认期间数据变化和网络失败不会清缓存或释放名额', async () => {
  const pet = await repo.savePet({ name: '保留宠物', species: '猫' });
  const original = store.getCloudSession();
  const family = page(); await family.onShow();
  confirm.mockRejectedValueOnce(new Error('取消'));
  await family.onDissolve();
  expect(store.getCloudSession()).toEqual(original);
  expect(wx.reLaunch).not.toHaveBeenCalled();
  confirm.mockImplementationOnce(async () => { await repo.savePet({ name: '新增宠物', species: '狗' }); });
  await family.onDissolve();
  expect(family.data.error).toContain('重新确认');
  expect(store.getCloudSession()).toEqual(original);
  rpc.mockRejectedValueOnce(new Error('网络中断'));
  await family.onDissolve();
  expect(family.data.error).toBe('网络中断');
  expect(store.getPets().some(p => p.id === pet.id)).toBe(true);
  expect(await callCloud('family.list')).toHaveLength(1);
});

test('普通成员退出仅移除自己，保留日记并选中剩余家庭', async () => {
  const shared = store.getCloudSession()!;
  const pet = await repo.savePet({ name: '共享宠物', species: '猫' });
  const invite = await callCloud<{ token: string }>('invite.create', { familyId: shared.familyId });
  identity = 'bob'; await repo.connectCloud();
  const own = store.getCloudSession()!;
  await callCloud('invite.accept', { token: invite.token });
  await repo.selectFamily(shared.familyId);
  await repo.addRecord({ petId: pet.id, date: '2026-10-15', text: '成员日记', tags: [], photos: [], clientId: 'bob-record' });
  const family = page(); await family.onShow();
  expect(family.data.owner).toBe(false);
  await family.onLeave();
  const fresh = page(); await fresh.onShow();
  expect(store.getCloudSession()).toEqual(own);
  expect(db.dump('diaries')).toHaveLength(1);
  expect(db.dump('families').find((f: any) => f._id === shared.familyId).dissolvedAt).toBeUndefined();
});

test('其他设备解散当前家庭后，刷新拒绝旧权限并清理聊天缓存，保留其他家庭', async () => {
  const original = store.getCloudSession()!;
  const pet = await repo.savePet({ name: '旧空间宠物', species: '猫' });
  saveLocalSession(pet.id, newSession());
  const second = await callCloud<repo.Family>('family.create', { name: '其他家庭', clientId: 'other' });
  const otherKey = `jd_chat_${original.userId}_${second.id}_other-pet`;
  wx.setStorageSync(otherKey, { messages: [] });
  const summary = await callCloud<{ revision: number }>('family.summary', { familyId: original.familyId });
  await callCloud('family.dissolve', { familyId: original.familyId, revision: summary.revision });
  await expect(repo.refreshCloud()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(store.getCloudSession()!.familyId).toBe('');
  expect(store.getPets()).toEqual([]);
  expect(loadLocalSession(pet.id)).toBeNull();
  expect(wx.getStorageSync(otherKey)).toEqual({ messages: [] });
  await repo.connectCloud();
  expect(store.getCloudSession()!.familyId).toBe(second.id);
});

test('原家庭已解散时移除测试返回目标，不静默换目标；随后可管理当前家庭', async () => {
  const original = store.getCloudSession()!;
  enableDeveloperMode(); await enterEmptyTestFamily();
  const current = store.getCloudSession();
  const summary = await callCloud<{ revision: number }>('family.summary', { familyId: original.familyId });
  await callCloud('family.dissolve', { familyId: original.familyId, revision: summary.revision });
  await expect(returnToOriginalFamily()).rejects.toThrow('原家庭已不可访问');
  expect(store.getCloudSession()).toEqual(current);
  expect(getNewUserTestState()!.originalFamilyId).toBe('');
  expect(getNewUserTestState()!.testFamilyId).toBe(current!.familyId);
});

test('解散已成功但响应丢失时，刷新列表可恢复，不会复活旧家庭', async () => {
  const family = page(); await family.onShow();
  const originalRpc = rpc.getMockImplementation()!;
  let lost = false;
  rpc.mockImplementation(async (action, data) => {
    const result = await originalRpc(action, data);
    if (action === 'family.dissolve' && !lost) { lost = true; throw new CloudError('NETWORK', '响应丢失，请刷新家庭列表确认'); }
    return result;
  });
  await family.onDissolve();
  expect(family.data.error).toContain('响应丢失');
  expect(await callCloud('family.list')).toEqual([]);
  await family.onConnect();
  expect(family.data).toMatchObject({ connected: true, families: [], familyId: '', error: '' });
  expect(db.dump('families')).toHaveLength(1);
});

test('多人家庭需要两次确认，第二次取消时所有成员和数据保持原样', async () => {
  const familyId = store.getCloudSession()!.familyId;
  await service({ action: 'auth.login' }, { OPENID: 'bob', APPID: 'demo' });
  const invite = await callCloud<{ token: string }>('invite.create', { familyId });
  await service({ action: 'invite.accept', data: { token: invite.token } }, { OPENID: 'bob', APPID: 'demo' });
  const family = page(); await family.onShow();
  confirm.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('保留家庭'));
  await family.onDissolve();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(confirm.mock.calls[0][0].content).toContain('2 位成员');
  expect(db.dump('families').find((f: any) => f._id === familyId).members).toHaveLength(2);
  expect(wx.reLaunch).not.toHaveBeenCalled();
  await family.onDissolve();
  expect(wx.reLaunch).toHaveBeenCalledTimes(1);
});

test('没有家庭也能通过邀请码重新加入，账号与模型配置保留', async () => {
  const family = page(); await family.onShow(); await family.onDissolve();
  await service({ action: 'auth.login' }, { OPENID: 'bob', APPID: 'demo' });
  const families = await service({ action: 'family.list' }, { OPENID: 'bob', APPID: 'demo' });
  const invite = await service({ action: 'invite.create', data: { familyId: families[0].id } }, { OPENID: 'bob', APPID: 'demo' });
  const fresh = page(); await fresh.onShow();
  fresh.data.inviteInput = invite.token;
  await fresh.onJoin();
  expect(fresh.data).toMatchObject({ connected: true, familyId: families[0].id, owner: false });
  expect(store.getModelConfig()).toEqual(config);
});
