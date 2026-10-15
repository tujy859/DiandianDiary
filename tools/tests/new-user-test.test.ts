/** 使用真实家庭 / 宠物 / 日记服务验证隔离，不访问实际云环境。 */
import * as store from '../../utils/store';
import * as repo from '../../utils/repository';
import { callCloud, CloudError } from '../../utils/cloud';
import { enableDeveloperMode } from '../../utils/developer';
import { disableDeveloperMode } from '../../utils/developer';
import { enterEmptyTestFamily, returnToOriginalFamily, getNewUserTestState, isTestFamily } from '../../utils/new-user-test';
import { memoryDatabase } from './helpers/cloud-db';
const { createService } = require('../../cloudfunctions/diaryApi/service');
jest.mock('../../utils/cloud', () => ({ ...jest.requireActual('../../utils/cloud'), callCloud: jest.fn() }));
const rpc = callCloud as jest.Mock;
let db: any;
let original: store.CloudSession;
let originalPet: store.Pet;
let baseRpc: (action: string, data?: any) => Promise<any>;
const diary = (petId: string, clientId: string) => ({ petId, date: '2026-10-15', text: '演示记录', tags: [], photos: [], clientId });

beforeEach(async () => {
  (wx as any).clearStorageSync(); rpc.mockReset();
  enableDeveloperMode();
  db = memoryDatabase();
  const service = createService({ db, storage: {} });
  baseRpc = async (action, data = {}) => {
    try { return await service({ action, data }, { OPENID: 'tester', APPID: 'demo' }); }
    catch (err: any) { throw new CloudError(err.code, err.message); }
  };
  rpc.mockImplementation(baseRpc);
  await repo.connectCloud();
  original = store.getCloudSession()!;
  originalPet = await repo.savePet({ name: '原家庭宠物', species: '猫' });
  await repo.addRecord(diary(originalPet.id, 'original-record'));
  store.saveModelConfig({ provider: '自定义', baseUrl: 'https://model.example', apiKey: 'demo-key', model: 'demo' });
});

test('创建独立家庭并实际保存测试日记，返回后原宠物 / 日记 / 模型配置保持原样', async () => {
  const originalPets = db.dump('pets');
  const originalDiaries = db.dump('diaries');
  const model = store.getModelConfig();
  await enterEmptyTestFamily();
  const testId = store.getCloudSession()!.familyId;
  expect(testId).not.toBe(original.familyId);
  expect(isTestFamily()).toBe(true);
  expect(store.getPets()).toEqual([]);
  expect(store.getRecords()).toEqual([]);
  const testPet = await repo.savePet({ name: '测试宠物', species: '狗' });
  await repo.addRecord(diary(testPet.id, 'test-record'));
  await returnToOriginalFamily();
  expect(store.getCloudSession()).toEqual(original);
  expect(store.getPets().map(p => p.id)).toEqual([originalPet.id]);
  expect(db.dump('pets').filter((p: any) => p.familyId === original.familyId)).toEqual(originalPets);
  expect(db.dump('diaries').filter((d: any) => d.familyId === original.familyId)).toEqual(originalDiaries);
  expect(db.dump('diaries').some((d: any) => d.familyId === testId)).toBe(true);
  expect(store.getModelConfig()).toEqual(model);
  expect(getNewUserTestState()!.testFamilyId).toBe(testId);
  expect(isTestFamily()).toBe(false);
});

test('仍为空的测试家庭复用；已有宠物再新建，返回目标仍是最初原家庭', async () => {
  await enterEmptyTestFamily();
  const first = store.getCloudSession()!.familyId;
  await enterEmptyTestFamily();
  expect(store.getCloudSession()!.familyId).toBe(first);
  expect(db.dump('families')).toHaveLength(2);
  await repo.savePet({ name: '测试宠物', species: '猫' });
  await enterEmptyTestFamily();
  expect(store.getCloudSession()!.familyId).not.toBe(first);
  expect(db.dump('families')).toHaveLength(3);
  expect(getNewUserTestState()!.originalFamilyId).toBe(original.familyId);
  await returnToOriginalFamily();
  expect(store.getCloudSession()).toEqual(original);
});

test('创建已提交但响应丢失，重试使用相同请求 ID，不重复创建家庭', async () => {
  let loseResponse = true;
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'family.create' && loseResponse) { loseResponse = false; throw new Error('响应丢失'); }
    return result;
  });
  await expect(enterEmptyTestFamily()).rejects.toThrow('响应丢失');
  expect(store.getCloudSession()).toEqual(original);
  const pending = getNewUserTestState()!.pendingClientId;
  expect(pending).toBeTruthy();
  await enterEmptyTestFamily();
  const requests = rpc.mock.calls.filter(([action]) => action === 'family.create');
  expect(requests[0][1].clientId).toBe(requests[1][1].clientId);
  expect(db.dump('families')).toHaveLength(2);
});

test('切换到测试家庭时刷新失败回滚，并保留恢复信息供重试复用', async () => {
  let fail = true;
  rpc.mockImplementation((action, data) => {
    if (action === 'pet.list' && data.familyId !== original.familyId && fail) { fail = false; return Promise.reject(new Error('网络中断')); }
    return baseRpc(action, data);
  });
  await expect(enterEmptyTestFamily()).rejects.toThrow('网络中断');
  expect(store.getCloudSession()).toEqual(original);
  expect(store.getPets()[0].id).toBe(originalPet.id);
  const testId = getNewUserTestState()!.testFamilyId;
  await enterEmptyTestFamily();
  expect(store.getCloudSession()!.familyId).toBe(testId);
  expect(db.dump('families')).toHaveLength(2);
});

test('返回原家庭刷新失败时留在测试家庭并保留返回目标，重试可恢复', async () => {
  await enterEmptyTestFamily();
  const testId = store.getCloudSession()!.familyId;
  let fail = true;
  rpc.mockImplementation((action, data) => {
    if (action === 'pet.list' && data.familyId === original.familyId && fail) { fail = false; return Promise.reject(new Error('网络中断')); }
    return baseRpc(action, data);
  });
  await expect(returnToOriginalFamily()).rejects.toThrow('网络中断');
  expect(store.getCloudSession()!.familyId).toBe(testId);
  expect(getNewUserTestState()!.originalFamilyId).toBe(original.familyId);
  await returnToOriginalFamily();
  expect(store.getCloudSession()).toEqual(original);
});

test('返回目标失去访问权限时保留当前家庭，不静默选用其他家庭', async () => {
  await enterEmptyTestFamily();
  const before = store.getCloudSession();
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    return action === 'family.list' ? result.filter((f: repo.Family) => f.id !== original.familyId) : result;
  });
  await expect(returnToOriginalFamily()).rejects.toThrow('原家庭已不可访问');
  expect(store.getCloudSession()).toEqual(before);
  expect(getNewUserTestState()).not.toBeNull();
});

test('达到家庭上限时提示并保留原家庭，不删除已有家庭', async () => {
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    return action === 'family.list' ? [...result, ...Array.from({ length: 9 }, (_, i) => ({ id: `demo-${i}`, name: '已有家庭', members: [] }))] : result;
  });
  await expect(enterEmptyTestFamily()).rejects.toThrow('最多加入 10 个家庭');
  expect(store.getCloudSession()).toEqual(original);
  expect(db.dump('families')).toHaveLength(1);
  expect(getNewUserTestState()!.originalFamilyId).toBe(original.familyId);
});

test('开发模式未开启时不能创建测试家庭，测试状态按账号隔离', async () => {
  (wx as any).removeStorageSync('jd_developer_mode');
  rpc.mockClear();
  await expect(enterEmptyTestFamily()).rejects.toThrow('开启开发者模式');
  expect(rpc).not.toHaveBeenCalled();
  enableDeveloperMode();
  await enterEmptyTestFamily();
  store.setCloudSession({ userId: 'another-user', familyId: 'another-family' });
  expect(getNewUserTestState()).toBeNull();
  expect(isTestFamily()).toBe(false);
});

test('创建请求等待中切换账号，迟到结果不能覆盖新账号状态', async () => {
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'family.create') store.setCloudSession({ userId: 'another-user', familyId: 'another-family' });
    return result;
  });
  await expect(enterEmptyTestFamily()).rejects.toThrow('账号或家庭已切换');
  expect(store.getCloudSession()!.userId).toBe('another-user');
  expect(getNewUserTestState()).toBeNull();
});

test('返回原家庭后再次进入，最近测试家庭仍为空时继续复用', async () => {
  await enterEmptyTestFamily();
  const testId = store.getCloudSession()!.familyId;
  await returnToOriginalFamily();
  await enterEmptyTestFamily();
  expect(store.getCloudSession()!.familyId).toBe(testId);
  expect(db.dump('families')).toHaveLength(2);
  expect(getNewUserTestState()!.originalFamilyId).toBe(original.familyId);
});

test('创建请求期间关闭开发者模式，迟到响应不能自动切进测试家庭', async () => {
  rpc.mockImplementation(async (action, data) => {
    const result = await baseRpc(action, data);
    if (action === 'family.create') disableDeveloperMode();
    return result;
  });
  await expect(enterEmptyTestFamily()).rejects.toThrow('开发者模式已关闭');
  expect(store.getCloudSession()).toEqual(original);
});
