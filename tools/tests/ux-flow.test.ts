/** 真实页面方法的跨页与失败状态回归；所有云端 / 模型请求均为模拟。 */
import * as store from '../../utils/store';
import { refreshCloudIfStale, connectCloud } from '../../utils/repository';
import { testConnection } from '../../utils/llm';
import { openAddPet, consumeAddPetRequest } from '../../utils/pet-navigation';
import { enableDeveloperMode } from '../../utils/developer';
import { isDeveloperMode } from '../../utils/developer';
import Dialog from 'tdesign-miniprogram/dialog/index';
import { callCloud } from '../../utils/cloud';

jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { alert: jest.fn(), confirm: jest.fn() } }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
jest.mock('tdesign-miniprogram/action-sheet/index', () => ({ __esModule: true, default: { show: jest.fn() } }), { virtual: true });
jest.mock('../../utils/repository', () => ({ refreshCloudIfStale: jest.fn(), connectCloud: jest.fn() }));
jest.mock('../../utils/llm', () => ({ ...jest.requireActual('../../utils/llm'), testConnection: jest.fn() }));
jest.mock('../../utils/layout', () => ({ resetViewport: jest.fn(), getLayout: () => ({ tabbarHeight: 56, viewportHeight: 667 }) }));
jest.mock('../../utils/cloud', () => ({ ...jest.requireActual('../../utils/cloud'), callCloud: jest.fn() }));

const definitions: Record<string, any> = {};
const refresh = refreshCloudIfStale as jest.Mock;
const config = { provider: 'DeepSeek', baseUrl: 'https://model.example', apiKey: 'demo-key', model: 'demo-model' };
const pet: store.Pet = { id: 'demo-pet', name: '点点', species: '猫', createdAt: 1 };
const record: store.DiaryRecord = { id: 'demo-record', petId: pet.id, date: '2026-10-15', text: '散步', tags: [], photos: [], createdAt: 1, updatedAt: 1 };

beforeAll(() => {
  for (const name of ['diary', 'album', 'mine', 'onboard', 'model', 'new-user-test', 'selftest']) {
    (global as any).Page = (value: any) => { definitions[name] = value; };
    require(`../../pages/${name}/${name}.ts`);
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  (wx as any).getAppBaseInfo = () => ({ SDKVersion: '3.15.1' });
  (wx as any).cloud = { init: jest.fn(), extend: { AI: { createModel: jest.fn() } } };
  (wx as any).clearStorageSync();
  store.setCloudSession({ userId: 'demo-user', familyId: 'demo-family' });
  store.saveModelConfig(config);
  consumeAddPetRequest();
  refresh.mockReset().mockResolvedValue(true);
  (testConnection as jest.Mock).mockReset().mockResolvedValue('收到');
  (callCloud as jest.Mock).mockReset().mockResolvedValue([{ id: 'demo-family', name: '演示家庭' }]);
  jest.spyOn(wx, 'switchTab').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function page(name: string) {
  const instance = { ...definitions[name], data: JSON.parse(JSON.stringify(definitions[name].data || {})) };
  instance.setData = (patch: any) => {
    for (const [key, value] of Object.entries(patch)) {
      const [parent, child] = key.split('.');
      if (child) instance.data[parent][child] = value;
      else instance.data[parent] = value;
    }
  };
  return instance;
}

const cloudConfig = { source: 'cloud' as const, provider: '微信云开发 AI', baseUrl: '', apiKey: '', model: 'hy3' };
const chooseCloud = { currentTarget: { dataset: { source: 'cloud' } } };

test.each(['model', 'onboard'])('%s 可选云开发，切换不保存且不混用自定义凭证', name => {
  enableDeveloperMode();
  const instance = page(name); instance.onLoad(name === 'onboard' ? { replay: '1' } : {});
  instance.onSelectSource(chooseCloud);
  expect(instance.data.form).toEqual(cloudConfig);
  expect(instance.data.modelHelp).toContain('聊天文字');
  expect(store.getModelConfig()).toEqual(config);
  instance.onSelectSource({ currentTarget: { dataset: { source: 'custom' } } });
  expect(instance.data.form).toEqual({ ...config, source: 'custom' });
  expect(store.getModelConfig()).toEqual(config);
});

test.each(['model', 'onboard'])('%s 来回切换保留最新输入，测试云开发不发送自定义密钥', async name => {
  enableDeveloperMode();
  const instance = page(name); instance.onLoad({ replay: '1' });
  instance.onSelectProvider({ currentTarget: { dataset: { value: 'OpenAI 兼容' } } });
  instance.onBaseUrl({ detail: { value: 'https://edited.example/v1' } });
  instance.onApiKey({ detail: { value: 'edited-demo-key' } });
  instance.onModel({ detail: { value: 'edited-model' } });
  const edited = { ...instance.data.form };
  instance.onSelectSource(chooseCloud);
  if (name === 'model') await instance.onTest(); else await instance.onTestModel();
  expect(testConnection).toHaveBeenLastCalledWith(cloudConfig);
  instance.onSelectSource({ currentTarget: { dataset: { source: 'custom' } } });
  expect(instance.data.form).toEqual(edited);
  instance.onSelectSource(chooseCloud);
  instance.onSelectSource({ currentTarget: { dataset: { source: 'custom' } } });
  expect(instance.data.form).toEqual(edited);
  if (name === 'model') await instance.onTest(); else await instance.onTestModel();
  expect(testConnection).toHaveBeenLastCalledWith(edited);
  expect(store.getModelConfig()).toEqual(config);
});

test('清除配置后不能通过切换来源恢复旧密钥，离开页面释放草稿', async () => {
  const model = page('model'); model.onLoad(); model.onSelectSource(chooseCloud);
  (Dialog.confirm as jest.Mock).mockResolvedValueOnce(undefined);
  model.onClear(); await Promise.resolve();
  model.onSelectSource(chooseCloud);
  model.onSelectSource({ currentTarget: { dataset: { source: 'custom' } } });
  expect(model.data.form.apiKey).toBe(''); expect(store.getModelConfig().apiKey).toBe('');
  model.onApiKey({ detail: { value: 'temporary-demo-key' } });
  model.onSelectSource(chooseCloud); model.onUnload();
  expect(model._customModelDraft).toBeUndefined();
  const reopened = page('model'); reopened.onLoad();
  expect(reopened.data.form.apiKey).toBe('');
});

test('设置页测试云开发不自动保存，显式保存后无密钥，重新进入保留来源', async () => {
  const model = page('model'); model.onLoad(); model.onSelectSource(chooseCloud);
  await model.onTest();
  expect(testConnection).toHaveBeenCalledWith(cloudConfig);
  expect(store.getModelConfig()).toEqual(config);
  model.onSave(); expect(store.getModelConfig()).toEqual(cloudConfig);
  const reopened = page('model'); reopened.onLoad();
  expect(reopened.data.source).toBe('cloud'); expect(reopened.data.form).toEqual(cloudConfig);
});

test('初次引导测试不保存不跳页，确认后才保存云开发，已有配置可进入应用', async () => {
  store.clearModelConfig();
  const onboard = page('onboard'); onboard.onLoad(); onboard.onSelectSource(chooseCloud);
  await onboard.onTestModel();
  expect(testConnection).toHaveBeenCalledWith(cloudConfig);
  expect(store.getModelConfig().apiKey).toBe('');
  expect(wx.switchTab).not.toHaveBeenCalled();
  await onboard.onConfirmModel();
  expect(store.getModelConfig()).toEqual(cloudConfig);
  expect(wx.switchTab).toHaveBeenCalled();
  const reopened = page('onboard'); await reopened.onLoad();
  expect(reopened.data.source).toBe('cloud');
});

test.each(['model', 'onboard'])('%s 不将缺失 AI 能力的配置保存成可用', async name => {
  enableDeveloperMode();
  const instance = page(name); instance.onLoad({ replay: '1' }); instance.onSelectSource(chooseCloud);
  (wx as any).cloud.extend = {};
  if (name === 'model') instance.onSave(); else await instance.onConfirmModel();
  expect(store.getModelConfig()).toEqual(config);
  expect(testConnection).not.toHaveBeenCalled();
});

test('引导演练选择云开发仍不覆盖已保存 API，忙碌时不能切换来源', async () => {
  enableDeveloperMode();
  const onboard = page('onboard'); onboard.onLoad({ replay: '1' });
  onboard.onSelectSource(chooseCloud); await onboard.onTestModel();
  expect(store.getModelConfig()).toEqual(config);
  const model = page('model'); model.onLoad(); model.data.testing = true;
  model.onSelectSource(chooseCloud); expect(model.data.source).toBe('custom');
});

test('引导演练回显已保存的来源，测试和确认均不覆盖正式配置', async () => {
  enableDeveloperMode(); store.saveModelConfig(cloudConfig);
  const onboard = page('onboard'); onboard.onLoad({ replay: '1' });
  expect(onboard.data.source).toBe('cloud');
  onboard.onSelectSource({ currentTarget: { dataset: { source: 'custom' } } });
  onboard.data.form = { ...config };
  await onboard.onTestModel();
  expect(onboard.data.modelTest).toBe('success'); expect(wx.switchTab).not.toHaveBeenCalled();
  expect(store.getModelConfig()).toEqual(cloudConfig);
  await onboard.onConfirmModel();
  expect(store.getModelConfig()).toEqual(cloudConfig); expect(wx.switchTab).toHaveBeenCalled();
});

test('引导连接失败不保存，修改字段令测试结果失效；可单独确认有效配置', async () => {
  store.clearModelConfig();
  const onboard = page('onboard'); onboard.onLoad(); onboard.onSelectSource(chooseCloud);
  (testConnection as jest.Mock).mockRejectedValueOnce(new Error('网络中断'));
  await onboard.onTestModel();
  expect(onboard.data).toMatchObject({ modelTest: 'failed', busy: false, error: '网络中断' });
  expect(store.getModelConfig().source).toBeUndefined(); expect(wx.switchTab).not.toHaveBeenCalled();
  await onboard.onTestModel(); expect(onboard.data.modelTest).toBe('success');
  onboard.onSelectSource({ currentTarget: { dataset: { source: 'custom' } } });
  expect(onboard.data).toMatchObject({ modelTest: 'idle', error: '' });
  onboard.data.form = { ...config };
  await onboard.onConfirmModel();
  expect(store.getModelConfig()).toEqual({ ...config, source: 'custom' });
  expect(testConnection).toHaveBeenCalledTimes(2);
});

test('跨年日记详情显示真实年份、星期与天数，不会显示成当年的 14 天前', () => {
  jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00+08:00') });
  try {
    store.cacheCloudData([pet], [{ ...record, date: '2025-10-01' }]);
    const diary = page('diary'); diary.onLoad({ id: record.id }); diary.reload();
    expect(diary.data.record.dateText).toBe('2025年10月1日 · 周三');
    expect(diary.data.record.rel).toBe('379天前');
  } finally { jest.useRealTimers(); }
});

test('日记缓存无记录时，读取失败保留错误状态；重试成功才展示内容', async () => {
  const diary = page('diary'); diary.onLoad({ id: record.id });
  refresh.mockRejectedValueOnce(new Error('网络不可用'));
  await diary.onShow();
  expect(diary.data).toMatchObject({ record: null, loadError: '网络不可用', loading: false, refreshing: false });
  refresh.mockImplementationOnce(async () => { store.cacheCloudData([pet], [record]); return true; });
  await diary.onRetry();
  expect(refresh).toHaveBeenLastCalledWith(0);
  expect(diary.data.loadError).toBe('');
  expect(diary.data.record.text).toBe('散步');
});

test('日记读取成功但无记录才显示缺失；必须绕过刷新节流确认', async () => {
  const diary = page('diary'); diary.onLoad({ id: record.id });
  await diary.onShow();
  expect(refresh).toHaveBeenCalledWith(0);
  expect(diary.data).toMatchObject({ record: null, loading: false, loadError: '' });
});

test('日记已有缓存时刷新失败，保留可见内容与持续错误提示', async () => {
  store.cacheCloudData([pet], [record]);
  const diary = page('diary'); diary.onLoad({ id: record.id });
  refresh.mockRejectedValueOnce(new Error('网络不可用'));
  await diary.onShow();
  expect(diary.data.record.id).toBe(record.id);
  expect(diary.data.loadError).toBe('网络不可用');
});

test('时光册无缓存读取失败不会显示正常空状态，重试可恢复云端内容', async () => {
  const album = page('album');
  refresh.mockRejectedValueOnce(new Error('网络不可用'));
  await album.onShow();
  expect(album.data).toMatchObject({ records: [], loading: false, loadError: '网络不可用' });
  refresh.mockImplementationOnce(async () => { store.cacheCloudData([pet], [record]); return true; });
  await album.onRetry();
  expect(refresh).toHaveBeenLastCalledWith(0);
  expect(album.data.loadError).toBe('');
  expect(album.data.records[0].id).toBe(record.id);
});

test('时光册已有缓存时刷新失败保留记录，手动重试绕过节流', async () => {
  store.cacheCloudData([pet], [record]);
  const album = page('album');
  refresh.mockRejectedValueOnce(new Error('网络不可用'));
  await album.onShow();
  expect(album.data.records[0].id).toBe(record.id);
  expect(album.data.loadError).toBe('网络不可用');
  await album.onRetry();
  expect(refresh).toHaveBeenLastCalledWith(0);
  expect(album.data.loadError).toBe('');
});

test('身份或权限错误清理缓存后，日记和时光册不再展示原页面快照', async () => {
  for (const name of ['diary', 'album']) {
    store.setCloudSession({ userId: 'demo-user', familyId: 'demo-family' });
    store.cacheCloudData([pet], [record]);
    const instance = page(name);
    if (name === 'diary') instance.onLoad({ id: record.id });
    refresh.mockImplementationOnce(async () => { store.clearAll(); throw new Error('请重新连接云端'); });
    await instance.onShow();
    expect(instance.data.loadError).toBe('请重新连接云端');
    if (name === 'diary') expect(instance.data.record).toBeNull();
    else expect(instance.data.records).toEqual([]);
  }
});

test('跨页添加宠物直接打开表单，关闭后再次进我的不会重复弹出', async () => {
  openAddPet();
  expect(wx.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: '/pages/mine/mine' }));
  const mine = page('mine');
  await mine.onShow();
  expect(mine.data.formVisible).toBe(true);
  mine.onFormClose();
  await mine.onShow();
  expect(mine.data.formVisible).toBe(false);
});

test('跨页打开失败后清除添加意图，避免之后进入我的时意外弹出', () => {
  (wx.switchTab as jest.Mock).mockImplementationOnce((options) => options.fail());
  openAddPet();
  expect(consumeAddPetRequest()).toBe(false);
});

test('完成引导先读取家庭，无宠物才打开添加，已有云端宠物直接进聊天', async () => {
  const onboard = page('onboard');
  await onboard.finish();
  expect(consumeAddPetRequest()).toBe(true);
  expect(wx.switchTab).toHaveBeenLastCalledWith(expect.objectContaining({ url: '/pages/mine/mine' }));
  refresh.mockImplementationOnce(async () => { store.cacheCloudData([pet], []); return true; });
  await onboard.finish();
  expect(wx.switchTab).toHaveBeenLastCalledWith({ url: '/pages/chat/chat' });
  expect(consumeAddPetRequest()).toBe(false);
});

test('引导读取家庭失败时保留重试，不按空缓存误开创建表单', async () => {
  refresh.mockRejectedValueOnce(new Error('网络不可用'));
  const onboard = page('onboard');
  await onboard.finish();
  expect(wx.switchTab).not.toHaveBeenCalled();
  expect(onboard.data).toMatchObject({ busy: false, error: '网络不可用' });
  expect(consumeAddPetRequest()).toBe(false);
});

test('模型设置拒绝空白必填项，不能覆盖已有可用配置', () => {
  const model = page('model'); model.onLoad();
  model.data.form.apiKey = '   ';
  model.onSave();
  expect(store.getModelConfig()).toEqual(config);
});

test('两个模型入口仅对有预设的服务商显示默认值，自定义空配置不被补成 DeepSeek', () => {
  store.saveModelConfig({ provider: '自定义', baseUrl: '', apiKey: '', model: '' });
  for (const name of ['onboard', 'model']) {
    const instance = page(name); instance.onLoad();
    expect(instance.data.form.baseUrl).toBe('');
    expect(instance.data.form.model).toBe('');
    expect(instance.data.recommendedModel).toBe('');
    instance.onSelectProvider({ currentTarget: { dataset: { value: 'DeepSeek' } } });
    expect(instance.data.recommendedModel).toBeTruthy();
  }
});

test('测试当前配置不会自动保存，用户修改字段后连接成功提示失效', async () => {
  const model = page('model'); model.onLoad();
  model.onModel({ detail: { value: 'another-model' } });
  await model.onTest();
  expect(store.getModelConfig()).toEqual(config);
  expect(model.data.connectionNote).toContain('连接成功');
  model.onModel({ detail: { value: 'edited-again' } });
  expect(model.data.connectionNote).toBe('配置有改动，保存后生效');
});

test('新手引导演练强制展示欢迎和模型两步，不清除原登录或覆盖模型配置', async () => {
  enableDeveloperMode();
  (connectCloud as jest.Mock).mockResolvedValue({});
  const onboard = page('onboard');
  onboard.onLoad({ replay: '1' });
  expect(onboard.data).toMatchObject({ replay: true, step: 'login' });
  expect(onboard.data.form.apiKey).toBe(config.apiKey);
  expect(wx.switchTab).not.toHaveBeenCalled();
  await onboard.onStart();
  expect(onboard.data.step).toBe('model');
  onboard.data.form = { ...config, apiKey: 'different-demo-key' };
  await onboard.onTestModel();
  expect(store.getModelConfig()).toEqual(config);
  expect(store.getCloudSession()!.familyId).toBe('demo-family');
});

test('演练连接失败可使用现有配置继续，普通引导不被测试参数改变', async () => {
  const normal = page('onboard');
  await normal.onLoad({ replay: '1' });
  expect(normal.data.replay).toBe(false);
  enableDeveloperMode();
  const replay = page('onboard'); replay.onLoad({ replay: '1' });
  replay.data.form = { ...config, apiKey: 'different-demo-key' };
  (testConnection as jest.Mock).mockRejectedValueOnce(new Error('测试连接失败'));
  await replay.onTestModel();
  expect(replay.data.modelTest).toBe('failed');
  expect(store.getModelConfig()).toEqual(config);
  await replay.onConfirmModel();
  expect(store.getModelConfig()).toEqual(config);
});

test('连点关于开启开发者工具，切页后状态仍在；未开启时直接进入测试页不可操作', async () => {
  const tools = page('selftest'); await tools.onShow();
  expect(tools.data.allowed).toBe(false);
  const mine = page('mine');
  for (let i = 0; i < 5; i++) mine.onAbout();
  expect(mine.data.devMode).toBe(true);
  const fresh = page('mine'); await fresh.onShow();
  expect(fresh.data.devMode).toBe(true);
});

test('关闭开发者模式持久生效、保留账号配置，重新开启必须重新点击五次', async () => {
  enableDeveloperMode();
  const mine = page('mine'); await mine.onShow(); mine.data.aboutTaps = 5;
  const session = store.getCloudSession();
  (Dialog.confirm as jest.Mock).mockResolvedValueOnce(undefined);
  await mine.onDisableDeveloperMode();
  expect(isDeveloperMode()).toBe(false);
  expect(mine.data).toMatchObject({ devMode: false, aboutTaps: 0 });
  expect(store.getCloudSession()).toEqual(session);
  expect(store.getModelConfig()).toEqual(config);
  const fresh = page('mine'); await fresh.onShow();
  expect(fresh.data.devMode).toBe(false);
  const navigate = jest.spyOn(wx, 'navigateTo');
  fresh.goSelftest(); fresh.goNewUserTest();
  expect(navigate).not.toHaveBeenCalled();
  for (let i = 0; i < 4; i++) mine.onAbout();
  expect(isDeveloperMode()).toBe(false);
  mine.onAbout(); expect(isDeveloperMode()).toBe(true);
});

test('取消关闭时保留开关和测试家庭；关闭后测试提示条仍可进入家庭管理', async () => {
  enableDeveloperMode();
  wx.setStorageSync('jd_new_user_test_demo-user', { originalFamilyId: 'original-family', originalFamilyName: '原家庭', testFamilyId: 'demo-family' });
  const mine = page('mine');
  (Dialog.confirm as jest.Mock).mockRejectedValueOnce(new Error('取消'));
  await mine.onDisableDeveloperMode();
  expect(isDeveloperMode()).toBe(true);
  (Dialog.confirm as jest.Mock).mockResolvedValueOnce(undefined);
  await mine.onDisableDeveloperMode();
  expect((Dialog.confirm as jest.Mock).mock.calls[1][0].content).toContain('当前仍在测试家庭');
  expect(wx.getStorageSync('jd_new_user_test_demo-user').originalFamilyId).toBe('original-family');
  let component: any;
  (global as any).Component = (value: any) => { component = value; };
  require('../../components/test-space-bar/index.ts');
  const navigate = jest.spyOn(wx, 'navigateTo'); component.methods.onManage();
  expect(navigate).toHaveBeenCalledWith({ url: '/pages/family/family' });
});

test('测试页操作等待中防止重复执行，失败后恢复可重试状态', async () => {
  enableDeveloperMode();
  const tools = page('selftest');
  tools.onShow();
  let fail!: (reason: Error) => void;
  const pending = new Promise<void>((_, reject) => { fail = reject; });
  const first = tools.firstUseAction(() => pending);
  const extra = jest.fn();
  await tools.firstUseAction(extra);
  expect(extra).not.toHaveBeenCalled();
  fail(new Error('网络中断')); await first;
  expect(tools.data).toMatchObject({ firstUseBusy: false, firstUseError: '网络中断' });
});

test('统一开发测试按阶段进入，只有首次使用分区读取家庭，旧入口重定向', async () => {
  enableDeveloperMode();
  const tools = page('selftest'); tools.onLoad({ section: 'start' }); await tools.onShow();
  expect(tools.data).toMatchObject({ allowed: true, section: 'start', currentFamilyName: '演示家庭', results: [] });
  expect(callCloud).toHaveBeenCalledTimes(1);
  tools.onSection({ currentTarget: { dataset: { section: 'core' } } });
  expect(tools.data.passed).toBe(12);
  expect(callCloud).toHaveBeenCalledTimes(1);
  const navigate = jest.spyOn(wx, 'navigateTo'); tools.onReplay();
  expect(navigate).toHaveBeenLastCalledWith({ url: '/pages/onboard/onboard?replay=1' });
  const redirect = jest.spyOn(wx, 'redirectTo'); page('new-user-test').onLoad();
  expect(redirect).toHaveBeenLastCalledWith({ url: '/pages/selftest/selftest?section=start' });
  expect(store.getCloudSession()?.familyId).toBe('demo-family');
});

test('首次使用家庭读取迟到时不覆盖重新进入的页面', async () => {
  enableDeveloperMode();
  let release!: (value: any) => void;
  (callCloud as jest.Mock).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const tools = page('selftest'); tools.onLoad({ section: 'start' });
  const old = tools.onShow(); tools.onHide();
  await tools.onShow(); expect(tools.data.currentFamilyName).toBe('演示家庭');
  release([{ id: 'demo-family', name: '旧请求' }]); await old;
  expect(tools.data.currentFamilyName).toBe('演示家庭');
});
