/** 真实页面方法的跨页与失败状态回归；所有云端 / 模型请求均为模拟。 */
import * as store from '../../utils/store';
import { refreshCloudIfStale, connectCloud } from '../../utils/repository';
import { testConnection } from '../../utils/llm';
import { openAddPet, consumeAddPetRequest } from '../../utils/pet-navigation';
import { enableDeveloperMode } from '../../utils/developer';

jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { alert: jest.fn(), confirm: jest.fn() } }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
jest.mock('tdesign-miniprogram/action-sheet/index', () => ({ __esModule: true, default: { show: jest.fn() } }), { virtual: true });
jest.mock('../../utils/repository', () => ({ refreshCloudIfStale: jest.fn(), connectCloud: jest.fn() }));
jest.mock('../../utils/llm', () => ({ ...jest.requireActual('../../utils/llm'), testConnection: jest.fn() }));
jest.mock('../../utils/layout', () => ({ resetViewport: jest.fn(), getLayout: () => ({ tabbarHeight: 56, viewportHeight: 667 }) }));

const definitions: Record<string, any> = {};
const refresh = refreshCloudIfStale as jest.Mock;
const config = { provider: 'DeepSeek', baseUrl: 'https://model.example', apiKey: 'demo-key', model: 'demo-model' };
const pet: store.Pet = { id: 'demo-pet', name: '点点', species: '猫', createdAt: 1 };
const record: store.DiaryRecord = { id: 'demo-record', petId: pet.id, date: '2026-10-15', text: '散步', tags: [], photos: [], createdAt: 1, updatedAt: 1 };

beforeAll(() => {
  for (const name of ['diary', 'album', 'mine', 'onboard', 'model', 'new-user-test']) {
    (global as any).Page = (value: any) => { definitions[name] = value; };
    require(`../../pages/${name}/${name}.ts`);
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  (wx as any).clearStorageSync();
  store.setCloudSession({ userId: 'demo-user', familyId: 'demo-family' });
  store.saveModelConfig(config);
  consumeAddPetRequest();
  refresh.mockReset().mockResolvedValue(true);
  (testConnection as jest.Mock).mockReset().mockResolvedValue('收到');
  jest.spyOn(wx, 'switchTab').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function page(name: string) {
  const instance = { ...definitions[name], data: JSON.parse(JSON.stringify(definitions[name].data)) };
  instance.setData = (patch: any) => {
    for (const [key, value] of Object.entries(patch)) {
      const [parent, child] = key.split('.');
      if (child) instance.data[parent][child] = value;
      else instance.data[parent] = value;
    }
  };
  return instance;
}

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
  expect(onboard.data.form.apiKey).toBe('');
  expect(wx.switchTab).not.toHaveBeenCalled();
  await onboard.onStart();
  expect(onboard.data.step).toBe('model');
  onboard.data.form = { ...config, apiKey: 'different-demo-key' };
  await onboard.onSaveModel();
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
  await replay.onSaveModel();
  expect(replay.data.testFailed).toBe(true);
  expect(store.getModelConfig()).toEqual(config);
  await replay.onUseSavedModel();
  expect(store.getModelConfig()).toEqual(config);
});

test('连点关于开启开发者工具，切页后状态仍在；未开启时直接进入测试页不可操作', async () => {
  const tools = page('new-user-test'); await tools.onShow();
  expect(tools.data.allowed).toBe(false);
  const mine = page('mine');
  for (let i = 0; i < 5; i++) mine.onAbout();
  expect(mine.data.devMode).toBe(true);
  const fresh = page('mine'); await fresh.onShow();
  expect(fresh.data.devMode).toBe(true);
});

test('测试页操作等待中防止重复执行，失败后恢复可重试状态', async () => {
  enableDeveloperMode();
  const tools = page('new-user-test');
  let fail!: (reason: Error) => void;
  const pending = new Promise<void>((_, reject) => { fail = reject; });
  const first = tools.run(() => pending);
  const extra = jest.fn();
  await tools.run(extra);
  expect(extra).not.toHaveBeenCalled();
  fail(new Error('网络中断')); await first;
  expect(tools.data).toMatchObject({ busy: false, error: '网络中断' });
});
