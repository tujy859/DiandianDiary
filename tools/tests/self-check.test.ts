import { CORE_SELF_CHECKS, runCoreSelfChecks } from '../../utils/self-check';
import { enableDeveloperMode, disableDeveloperMode } from '../../utils/developer';
import * as store from '../../utils/store';

let definition: any;
beforeAll(() => {
  (global as any).Page = (value: any) => { definition = value; };
  require('../../pages/selftest/selftest.ts');
});
beforeEach(() => { wx.clearStorageSync(); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
function page() {
  const instance = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  instance.setData = (patch: any) => Object.assign(instance.data, patch);
  return instance;
}

// 页面实际运行的每个用例直接加入默认 Jest 回归，不另抄一套断言。
test.each(CORE_SELF_CHECKS)('页面共用自检：$name', check => {
  const result = runCoreSelfChecks([check])[0];
  expect(result).toMatchObject({ id: check.id, pass: true });
});

test.each(['2026-01-01', '2026-12-31', '2030-07-01'])('运行日期 %s 不会令固定演示用例变成失败', date => {
  jest.useFakeTimers({ now: new Date(`${date}T12:00:00+08:00`) });
  expect(runCoreSelfChecks().filter(result => !result.pass)).toEqual([]);
});

test('核心自检不访问 Storage、文件、云端或模型网络，反复运行结果一致', () => {
  const spies = ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorageInfoSync', 'getFileSystemManager', 'request']
    .map(name => jest.spyOn(wx, name).mockImplementation(() => { throw new Error(`自检禁止访问 ${name}`); }));
  const first = runCoreSelfChecks(), second = runCoreSelfChecks();
  expect(first.filter(result => !result.pass)).toEqual([]);
  expect(second).toEqual(first);
  spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
});

test('单项异常显示失败并继续其他检查，不会中断整页', () => {
  const result = runCoreSelfChecks([
    { id: 'broken', name: '失败演示', run: () => { throw new Error('演示故障'); } },
    { id: 'next', name: '继续演示', run: () => '下一项正常完成' },
  ]);
  expect(result).toEqual([
    { id: 'broken', name: '失败演示', pass: false, detail: '演示故障' },
    { id: 'next', name: '继续演示', pass: true, detail: '下一项正常完成' },
  ]);
});

test('页面首跑和重跑保留所有家庭、聊天、模型、登录及测试状态', () => {
  store.setCloudSession({ userId: 'demo-user', familyId: 'demo-family' });
  store.cacheCloudData([{ id: 'pet', name: '演示宠物', species: '猫', createdAt: 1 }], []);
  wx.setStorageSync('jd_chat_demo-user_demo-family_pet', { messages: ['演示聊天'] });
  wx.setStorageSync('jd_new_user_test_demo-user', { originalFamilyId: 'original', testFamilyId: 'demo-family' });
  store.saveModelConfig({ provider: '自定义', baseUrl: 'https://model.example', apiKey: 'demo-key', model: 'demo' });
  enableDeveloperMode();
  const snapshot = () => Object.fromEntries(wx.getStorageInfoSync().keys.map((key: string) => [key, wx.getStorageSync(key)]));
  const before = JSON.stringify(snapshot());
  const get = jest.spyOn(wx, 'getStorageSync');
  const set = jest.spyOn(wx, 'setStorageSync');
  const remove = jest.spyOn(wx, 'removeStorageSync');
  const instance = page(); instance.onShow(); instance.onRerun();
  expect(instance.data).toMatchObject({ allowed: true, passed: CORE_SELF_CHECKS.length, failed: 0, running: false });
  expect(get.mock.calls.every(([key]) => key === 'jd_developer_mode')).toBe(true);
  expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  expect(JSON.stringify(snapshot())).toBe(before);
});

test('未开启或后来关闭开发者模式时，直接进入 / 重跑自检不会执行用例', () => {
  const instance = page(); instance.onShow(); instance.onRerun();
  expect(instance.data).toMatchObject({ allowed: false, passed: 0, failed: 0, results: [], lastRunAt: '' });
  enableDeveloperMode(); instance.onShow();
  expect(instance.data.results).toHaveLength(CORE_SELF_CHECKS.length);
  disableDeveloperMode(); instance.onShow(); instance.onRerun();
  expect(instance.data).toMatchObject({ allowed: false, results: [], lastRunAt: '' });
});
