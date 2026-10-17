/** 直接调用聊天页的真实事件方法，模拟异步网络和切换事件。 */
import { runAgent } from '../../utils/agent';
import { chatWithModel } from '../../utils/llm';
import * as store from '../../utils/store';
import { RequestToken } from '../../utils/cancellation';
import { today } from '../../utils/date';
import * as sessions from '../../utils/chat-store';
import { SESSION_GAP_MS, buildHistory, buildDraftStates } from '../../utils/context';
import { validateDraftUpdate } from '../../utils/draft';
import { enableDeveloperMode } from '../../utils/developer';
import { setTraceEnabled, getDebugTraces } from '../../utils/debug-trace';
import { CloudError } from '../../utils/cloud';
import * as repository from '../../utils/repository';
import Toast from 'tdesign-miniprogram/toast/index';
import Dialog from 'tdesign-miniprogram/dialog/index';

jest.mock('tdesign-miniprogram/action-sheet/index', () => ({ __esModule: true, default: { show: jest.fn() } }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { confirm: () => Promise.reject(), alert: jest.fn() } }), { virtual: true });
jest.mock('../../utils/agent', () => ({ runAgent: jest.fn(), AbortedError: jest.requireActual('../../utils/cancellation').AbortedError }));
jest.mock('../../utils/llm', () => ({
  chatWithModel: jest.fn(), isModelReady: () => true,
  summarizeTitle: () => Promise.resolve('聊聊洗澡那点事'),
  summarizeSession: () => Promise.resolve('聊了洗澡后怎么吹干'),
}));
jest.mock('../../utils/onboard', () => ({ guardReady: () => true }));
// 保存走云端，这里替换为本地写入，让用例只关注聊天页的交互与状态
jest.mock('../../utils/repository', () => {
  const actual = jest.requireActual('../../utils/repository');
  const local = jest.requireActual('../../utils/store');
  return { __esModule: true, ...actual, addRecord: jest.fn((input: any) => local.addRecord(input)) };
});
const run = runAgent as jest.Mock;
const json = chatWithModel as jest.Mock;
let definition: any;
let page: any;
let a: store.Pet;
let b: store.Pet;
const result = (reply: string) => ({ reply, drafts: [], refs: [], toolsUsed: [] });
const deferred = () => { let resolve!: (value: any) => void; let reject!: (value: any) => void;
  return { promise: new Promise<any>((ok, fail) => { resolve = ok; reject = fail; }), resolve: (value: any) => resolve(value), reject: (value: any) => reject(value) }; };

test.each(['QUOTA', 'AUTH', 'CONCURRENT', 'TIMEOUT', 'SDK_VERSION', 'CLOUD_AI'])('云开发 %s 错误直接提供重试，不再调用 JSON 通道', async code => {
  store.saveModelConfig({ source: 'cloud', provider: '微信云开发 AI', baseUrl: '', apiKey: '', model: 'hy3' });
  run.mockRejectedValueOnce(new CloudError(code, '云开发连接失败'));
  await page.replyByAI('合成输入', [], a);
  expect(json).not.toHaveBeenCalled();
  expect(page.data.messages[0]).toMatchObject({ retry: true, sourceText: '合成输入' });
  expect(page.data.aiThinking).toBe(false);
});

test('云开发明确不支持工具时仍可进入严格 JSON 降级', async () => {
  store.saveModelConfig({ source: 'cloud', provider: '微信云开发 AI', baseUrl: '', apiKey: '', model: 'hy3' });
  run.mockRejectedValueOnce(new CloudError('UNSUPPORTED_TOOLS', '不支持工具调用'));
  json.mockResolvedValueOnce({ reply: '你好', draft: null, query: null });
  await page.replyByAI('你好', [], a);
  expect(json).toHaveBeenCalledTimes(1); expect(page.data.messages[0].text).toBe('你好');
});

test('JSON 降级的纯记录只显示草稿，不展示背景查询或待确认文本', async () => {
  run.mockRejectedValueOnce(new Error('工具不可用'));
  json.mockResolvedValueOnce({ reply: '旧事情已经记过，请确认这条。',
    draft: { date: '2025-01-01', sourceText: '2025年1月1号领养了点点', text: '领养了点点', tags: ['领养'] },
    query: { keyword: '领养' } });
  await page.replyByAI('2025年1月1号领养了点点', [], a);
  expect(page.data.messages).toHaveLength(1);
  expect(page.data.messages[0].kind).toBe('draft');
});

test('同一请求日志包含工具失败、JSON 路径及最终外显引用，不采集聊天正文', async () => {
  store.setCloudSession({ userId: 'demo-user', familyId: 'demo-family' });
  enableDeveloperMode(); setTraceEnabled(true);
  run.mockRejectedValueOnce(new Error('HTTP 400'));
  json.mockResolvedValueOnce({ reply: '你好', draft: null, query: null });
  await page.replyByAI('这是私人原文', [], a);
  const rows = getDebugTraces();
  expect(rows).toHaveLength(1);
  expect(rows[0].events.some(e => e.phase === 'fallback.json')).toBe(true);
  expect(rows[0].events[rows[0].events.length - 1].detail.path).toBe('json');
  expect(JSON.stringify(rows)).not.toContain('私人原文');
});

beforeAll(() => {
  (global as any).Page = (options: any) => { definition = options; };
  require('../../pages/chat/chat.ts'); // 明确加载 TS，不能误测同名历史 JS 模板
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (global as any).__wxStub.clearStorageSync();
  a = store.savePet({ name: 'A', species: '猫' });
  b = store.savePet({ name: 'B', species: '狗' });
  page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), _abort: null };
  page.setData = (patch: any) => Object.entries(patch).forEach(([key, value]) => {
    const match = key.match(/^messages\[(\d+)\]\.draft$/);
    if (match) page.data.messages[Number(match[1])].draft = value;
    else page.data[key] = value;
  });
  page.data.currentPet = a;
  page.data.pets = [a, b];
  page.data.modelOn = true;
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllTimers(); jest.useRealTimers(); });

describe('聊天更正真实卡片', () => {
  const text = '日期应该是25年12月27号';
  function prepare() {
    jest.setSystemTime(new Date('2026-10-16T12:00:00+08:00'));
    page._savingDrafts = {};
    page.data.messages = [{ id: 'card', role: 'ai', kind: 'draft', time: Date.now(), draft: {
      key: 'card', petId: a.id, date: '2026-10-16', text: '25年12月27号，演示猫在吃饭', tags: ['吃饭'], photos: [], status: 'pending',
      rawInput: { text: '最初的用户原话', photos: [], provenance: 'direct' },
    } }];
    // 正式发送前 persist 已建立客户端话题身份；直接调用 replyByAI 的夹具也应保留它。
    page._session = sessions.newSession(); page._session.messages = page.data.messages;
    return validateDraftUpdate({ key: 'card', sourceText: text, date: '2025-12-27' }, buildDraftStates(page.data.messages, a.id), { text, petId: a.id });
  }
  test('工具方案应用同一张卡，确认文字来自实际日期；保存前不入库，保存后日期与原话一致', async () => {
    const update = prepare();
    run.mockResolvedValueOnce({ ...result('模型说已保存了'), draftUpdates: [update] });
    await page.replyByAI(text, [], a);
    expect(run.mock.calls[0][2].draftStatuses[0]).toMatchObject({ key: 'card', date: '2026-10-16' });
    expect(page.data.messages.filter((m: any) => m.kind === 'draft')).toHaveLength(1);
    expect(page.data.messages[0].draft).toMatchObject({ key: 'card', date: '2025-12-27', text: '25年12月27号，演示猫在吃饭', tags: ['吃饭'], status: 'pending' });
    expect(page.data.messages[1].text).toContain('2025-12-27'); expect(page.data.messages[1].text).not.toContain('模型说');
    expect(store.getRecords(a.id)).toEqual([]);
    await page.onCardSave({ detail: { key: 'card' } });
    const saved = store.getRecords(a.id)[0]; expect(saved.date).toBe('2025-12-27');
    expect(saved.rawInput!.text).toContain('最初的用户原话'); expect(saved.rawInput!.text).toContain(text);
    expect(page.data.messages[0].draft.status).toBe('saved');
  });
  test.each(['update', 'omitted', 'duplicate'])('JSON 降级 %s 路径也更新原卡且不信口头承诺', async mode => {
    prepare(); run.mockRejectedValueOnce(new Error('工具不可用'));
    json.mockResolvedValueOnce({ reply: '日期已经对了，不用修改', query: null,
      draft: mode === 'duplicate' ? { date: '2025-12-27', sourceText: text, text: '演示猫吃饭', tags: [] } : null,
      ...(mode === 'update' ? { update: { key: 'card', sourceText: text, date: '2025-12-27' } } : {}) });
    await page.replyByAI(text, [], a);
    expect(page.data.messages.filter((m: any) => m.kind === 'draft')).toHaveLength(1);
    expect(page.data.messages[0].draft.date).toBe('2025-12-27');
    expect(page.data.messages[1].text).toContain('已更新'); expect(page.data.messages[1].text).not.toContain('不用修改');
  });
  test('JSON 错误日期更正拒绝并保留原卡', async () => {
    prepare(); run.mockRejectedValueOnce(new Error('工具不可用'));
    json.mockResolvedValueOnce({ reply: '改好了', query: null, draft: null, update: { key: 'card', sourceText: text, date: '2026-10-16' } });
    await page.replyByAI(text, [], a);
    expect(page.data.messages[0].draft.date).toBe('2026-10-16'); expect(page.data.messages[1].text).toContain('尚未修改');
  });
  test('本机持久化失败时恢复原卡，不能显示成功', async () => {
    const update = prepare(); const before = JSON.stringify(page.data.messages[0].draft);
    jest.spyOn(sessions, 'saveLocalSession').mockImplementationOnce(() => { throw new Error('演示存储故障'); });
    run.mockResolvedValueOnce({ ...result('成功'), draftUpdates: [update] });
    await page.replyByAI(text, [], a);
    expect(JSON.stringify(page.data.messages[0].draft)).toBe(before);
    expect(page.data.messages[1].text).toContain('未能保存');
  });
  test.each(['saved', 'discarded', 'manual', 'saving'])('模型等待期间发生 %s，不覆盖最新卡片', async change => {
    const update = prepare(); const wait = deferred(); run.mockReturnValueOnce(wait.promise);
    const pending = page.replyByAI(text, [], a);
    if (change === 'manual') page.onCardSetDate({ detail: { key: 'card', date: '2025-12-26' } });
    else if (change === 'saving') page._savingDrafts.card = true;
    else page.updateDraft(0, { status: change });
    const before = JSON.stringify(page.data.messages[0].draft);
    wait.resolve({ ...result('修改成功'), draftUpdates: [update] }); await pending;
    expect(JSON.stringify(page.data.messages[0].draft)).toBe(before);
    expect(page.data.messages[1].text).toContain('未应用');
  });
  test.each(['stop', 'pet', 'session', 'epoch'])('等待期间 %s 后，迟到更正不改变卡片或添加成功回复', async change => {
    const update = prepare(); const wait = deferred(); run.mockReturnValueOnce(wait.promise);
    const pending = page.replyByAI(text, [], a);
    if (change === 'stop') page.onStop();
    else if (change === 'pet') page.data.currentPet = b;
    else if (change === 'session') page._session = sessions.newSession();
    else store.setCloudSession({ userId: 'new-demo-user', familyId: 'new-demo-family' });
    const before = JSON.stringify(page.data.messages);
    wait.resolve({ ...result('成功'), draftUpdates: [update] }); await pending;
    expect(JSON.stringify(page.data.messages)).toBe(before);
  });
  test('真正新建话题时，即使新旧云端 id 都为空，也拒绝旧话题的迟到回复并记录原因', async () => {
    prepare(); const wait = deferred(); run.mockReturnValueOnce(wait.promise);
    store.setCloudSession({ userId: 'demo-user', familyId: 'demo-family' });
    enableDeveloperMode(); setTraceEnabled(true);
    const pending = page.replyByAI(text, [], a);
    const oldClientId = page._session.clientId;
    expect(page.data.sessionId).toBe('');
    page.startNewSession();
    expect(page.data.sessionId).toBe(''); expect(page._session.clientId).not.toBe(oldClientId);
    wait.resolve(result('不应出现的旧回复')); await pending;
    expect(page.data.messages.some((m: any) => m.text === '不应出现的旧回复')).toBe(false);
    const trace = getDebugTraces().slice(-1)[0];
    expect(trace.status).toBe('cancelled');
    expect(trace.events.some(e => e.phase === 'request.invalidated' && e.detail.status === 'topic_changed')).toBe(true);
  });
  test('日期更正不改变照片或原照片依据，编辑后的附件仍按最新卡片保存', async () => {
    const update = prepare();
    page.data.messages[0].draft.photos = ['demo/photo.jpg'];
    run.mockResolvedValueOnce({ ...result(''), draftUpdates: [update] });
    await page.replyByAI(text, [], a);
    expect(page.data.messages[0].draft.photos).toEqual(['demo/photo.jpg']);
    expect(page.data.messages[0].draft.rawInput.photos).toEqual([]);
  });
  test('JSON 跨轮日期依据也能生成正确旧事卡', async () => {
    prepare(); page.data.messages = [{ id: 'year', role: 'user', kind: 'text', text: '这是去年拍的', time: Date.now() }];
    run.mockRejectedValueOnce(new Error('工具不可用'));
    const text = '12月27号，演示猫在吃饭';
    json.mockResolvedValueOnce({ reply: '', query: null, draft: { sourceText: text, text: '演示猫在吃饭', date: null, tags: ['吃饭'], dateSources: ['这是去年拍的'] } });
    await page.replyByAI(text, [], a);
    expect(page.data.messages[1].draft.date).toBe('2025-12-27');
    expect(page.data.messages[1].draft.rawInput.text).toContain('这是去年拍的');
  });
});

test('退出卸载页面后，迟到标题 / 摘要不能重新保存旧聊天', async () => {
  page._session = { ...sessions.newSession(), messages: [{ id: 'old', role: 'user', kind: 'text', text: '旧消息', time: Date.now() }] };
  const old = page._session;
  const pendingTitle = deferred(), pendingMeta = deferred();
  jest.spyOn(sessions, 'generateTitle').mockReturnValueOnce(pendingTitle.promise);
  jest.spyOn(sessions, 'generateSessionMeta').mockReturnValueOnce(pendingMeta.promise);
  const save = jest.spyOn(sessions, 'saveLocalSession');
  const title = page.maybeGenerateTitle();
  const finalize = page.finalizeSession(a.id, old);
  page.onUnload();
  pendingTitle.resolve('迟到标题'); pendingMeta.resolve({ title: '迟到标题', summary: '迟到摘要' });
  await Promise.all([title, finalize]);
  page.persist();
  expect(save).not.toHaveBeenCalled();
  expect(old.title).toBe('');
});

test('快捷问题填入当前宠物名字但不自动发送，收起键盘后恢复导航空间', () => {
  const tabbar = { data: { hidden: false }, setData: jest.fn((patch) => Object.assign(tabbar.data, patch)) };
  page.getTabBar = () => tabbar;
  page.onQuick({ currentTarget: { dataset: { mode: 'query', prompt: '上次给{pet}洗澡是什么时候？' } } });
  expect(page.data.inputValue).toBe('上次给A洗澡是什么时候？');
  expect(page.data.messages).toHaveLength(0);
  page.onKeyboardHeight({ detail: { height: 300 } });
  expect(tabbar.setData).toHaveBeenLastCalledWith({ hidden: true });
  page.onBlur();
  page.onKeyboardHeight({ detail: { height: 0 } });
  expect(tabbar.setData).toHaveBeenLastCalledWith({ hidden: false });
  expect(page.data.focusFlag).toBe(false);
});

test('停止后立即发新消息，旧请求迟到不能清除新请求或追加回复', async () => {
  const old = deferred(); const fresh = deferred();
  run.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first = page.replyByAI('旧消息', [], a);
  const oldToken = page._abort;
  page.onStop();
  expect(oldToken.aborted).toBe(true);
  const second = page.replyByAI('新消息', [], a);
  const newToken = page._abort;
  old.resolve(result('迟到的旧回复'));
  await first;
  expect(page._abort).toBe(newToken);
  expect(page.data.aiThinking).toBe(true);
  expect(page.data.messages.some((m: any) => m.text === '迟到的旧回复')).toBe(false);
  fresh.resolve(result('新的回复'));
  await second;
  expect(page.data.messages.some((m: any) => m.text === '新的回复')).toBe(true);
  expect(json).not.toHaveBeenCalled();
});
test('生成中切换宠物，旧请求不会写入另一只宠物的聊天', async () => {
  const wait = deferred(); run.mockReturnValueOnce(wait.promise);
  const pending = page.replyByAI('A的消息', [], a);
  page.onPetSelected({ detail: { index: 1 } });
  wait.resolve(result('A的迟到回复'));
  await pending;
  expect(page.data.currentPet.id).toBe(b.id);
  expect(page.data.messages).toHaveLength(0);
  expect(store.getMessages(b.id)).toHaveLength(0);
  expect(json).not.toHaveBeenCalled();
});
test('JSON 降级等待中停止，迟到草稿不出现，不继续本地兜底', async () => {
  run.mockRejectedValueOnce(new Error('不支持 tools'));
  const wait = deferred(); json.mockReturnValueOnce(wait.promise);
  const pending = page.replyByAI('今天洗澡了', [], a);
  await Promise.resolve();
  const token = page._abort;
  const effectiveToken = json.mock.calls[0][3];
  expect(effectiveToken).toBe(run.mock.calls[0][2].abortToken);
  expect(effectiveToken.aborted).toBe(false);
  page.onStop();
  expect(effectiveToken.aborted).toBe(true);
  wait.resolve({ reply: '已经记录', draft: { date: today(), text: '洗澡', tags: ['洗澡'] }, query: null });
  await pending;
  expect(page.data.messages).toHaveLength(1);
  expect(page.data.messages[0].text).toBe('已停止生成。');
});
test('模型调用失败只给错误与重试，重试保留照片', async () => {
  run.mockRejectedValueOnce(new Error('工具不支持'));
  json.mockRejectedValueOnce(new Error('模型没有返回有效 JSON'));
  const photos = ['/tmp/jd-user-data/photo.jpg'];
  await page.replyByAI('今天洗澡了', photos, a);
  const notice = page.data.messages.find((m: any) => m.retry);
  expect(notice.text).toContain('模型调用失败');
  expect(page.data.messages).toHaveLength(1);
  expect(notice.sourcePhotos).toEqual(photos);
  run.mockResolvedValueOnce(result('重试成功'));
  page.onRetry({ currentTarget: { dataset: { text: notice.sourceText } } });
  await Promise.resolve();
  expect(run.mock.calls[1][2].photos).toEqual(photos);
});
test('发送历史不重复包含本轮用户消息', async () => {
  run.mockResolvedValueOnce(result('收到'));
  page.data.messages = [{ id: 'old', role: 'ai', kind: 'text', text: '以前的回复' }];
  page.data.inputValue = '今天洗澡了';
  await page.onSend();
  expect(run.mock.calls[0][2].history).toEqual([{ role: 'assistant', content: '以前的回复' }]);
});
test('照片处理中切换宠物，旧照片不会产生串宠物消息', async () => {
  const wait = deferred(); jest.spyOn(store, 'persistPhotos').mockReturnValueOnce(wait.promise);
  page.data.inputValue = '今天洗澡了';
  page.data.attachments = ['temp.jpg'];
  const pending = page.onSend();
  expect(page.data.aiThinking).toBe(true);
  await page.onSend(); // 连点不再启动一次照片处理
  expect(store.persistPhotos).toHaveBeenCalledTimes(1);
  page.onPetSelected({ detail: { index: 1 } });
  wait.resolve(['saved.jpg']);
  await pending;
  expect(page.data.messages).toHaveLength(0);
  expect(run).not.toHaveBeenCalled();
});
test('重复点击已保存卡片不能新增重复记录', async () => {
  page.data.messages = [{ id: 'draft', role: 'ai', kind: 'draft', draft: { key: 'draft', petId: a.id, date: today(), text: '洗澡', tags: ['洗澡'], photos: [], status: 'pending' } }];
  await Promise.all([page.onCardSave({ detail: { key: 'draft' } }), page.onCardSave({ detail: { key: 'draft' } })]);
  expect(store.getRecords(a.id)).toHaveLength(1);
  expect(page.data.messages[0].draft.status).toBe('saved');
});

test('保存阶段实时可见，上传与云端确认期间不能重复保存或修改，完成后才标记已保存', async () => {
  const uploading = deferred(), confirming = deferred();
  page._visible = true;
  page.data.messages = [{ id: 'progress', role: 'ai', kind: 'draft', draft: { key: 'progress', petId: a.id,
    date: today(), text: '演示记录', tags: [], photos: [], status: 'pending' } }];
  (repository.addRecord as jest.Mock).mockImplementationOnce(async input => {
    input.onProgress({ stage: 'upload', photoIndex: 0, photoTotal: 2 });
    await uploading.promise;
    input.onProgress({ stage: 'confirm', photoIndex: 0, photoTotal: 2 });
    await confirming.promise;
    input.onProgress({ stage: 'save' });
    return store.addRecord(input);
  });
  const saving = page.onCardSave({ detail: { key: 'progress' } });
  await Promise.resolve(); await Promise.resolve();
  expect(page.data.saveStates.progress).toMatchObject({ busy: true, label: '正在上传照片 1/2…' });
  await page.onCardSave({ detail: { key: 'progress' } });
  page.onCardEdit({ detail: { key: 'progress' } }); page.onCardDiscard({ detail: { key: 'progress' } });
  expect(page.data.editorVisible).toBe(false); expect(page.data.messages[0].draft.status).toBe('pending');
  uploading.resolve(null); await Promise.resolve(); await Promise.resolve();
  expect(page.data.saveStates.progress).toMatchObject({ label: '正在保存日记…', stage: 'confirm' });
  expect(store.getRecords(a.id)).toHaveLength(0);
  confirming.resolve(null); await saving;
  expect(page.data.messages[0].draft.status).toBe('saved');
  expect(page.data.saveStates.progress).toBeUndefined();
  expect(store.getRecords(a.id)).toHaveLength(1);
});

test('保存失败的分类原因留在卡片且可重试；关闭执行日志也能看到阶段', async () => {
  page._visible = true;
  const wait = deferred();
  let progress: any;
  (repository.addRecord as jest.Mock).mockImplementationOnce(input => { progress = input.onProgress; return wait.promise; });
  page.data.messages = [{ id: 'failure', role: 'ai', kind: 'draft', draft: { key: 'failure', petId: a.id,
    date: today(), text: '演示记录', tags: [], photos: [], status: 'pending' } }];
  const saving = page.onCardSave({ detail: { key: 'failure' } });
  await Promise.resolve(); await Promise.resolve();
  progress({ stage: 'upload', photoIndex: 0, photoTotal: 1 });
  wait.reject(new CloudError('PHOTO_DOMAIN', 'private response'));
  await saving;
  expect(page.data.saveStates.failure).toMatchObject({ busy: false, failureTitle: '照片服务配置异常' });
  expect(page.data.saveStates.failure.detail).toContain('联系开发者');
  expect(JSON.stringify(page.data.saveStates)).not.toContain('private response');
  expect(Dialog.alert).toHaveBeenLastCalledWith(expect.objectContaining({ title: '照片服务配置异常' }));
  expect(page.data.messages[0].draft.status).toBe('failed');
});

test('页面卸载后不显示迟到进度或失败弹窗', async () => {
  page._visible = true;
  const wait = deferred(); let progress: any;
  (repository.addRecord as jest.Mock).mockImplementationOnce(input => { progress = input.onProgress; return wait.promise; });
  page.data.messages = [{ id: 'late', role: 'ai', kind: 'draft', draft: { key: 'late', petId: a.id,
    date: today(), text: '演示记录', tags: [], photos: [], status: 'pending' } }];
  const saving = page.onCardSave({ detail: { key: 'late' } });
  await Promise.resolve(); await Promise.resolve(); page.onUnload();
  const state = page.data.saveStates.late;
  progress({ stage: 'upload', photoIndex: 0, photoTotal: 1 }); wait.reject(new CloudError('PHOTO_TIMEOUT', 'private timeout'));
  await saving;
  expect(page.data.saveStates.late).toEqual(state); expect(Dialog.alert).not.toHaveBeenCalled();
});

test('保存期间切换宠物，迟到失败不污染新宠物，也不留下永久忙碌状态', async () => {
  page._visible = true;
  const wait = deferred();
  (repository.addRecord as jest.Mock).mockImplementationOnce(() => wait.promise);
  page.data.messages = [{ id: 'switch', role: 'ai', kind: 'draft', draft: { key: 'switch', petId: a.id,
    date: today(), text: '演示记录', tags: [], photos: [], status: 'pending' } }];
  const saving = page.onCardSave({ detail: { key: 'switch' } });
  await Promise.resolve(); await Promise.resolve();
  page.data.currentPet = b; page.data.messages = [];
  wait.reject(new CloudError('PHOTO_NETWORK', 'private response')); await saving;
  expect(page.data.saveStates.switch).toBeUndefined(); expect(Dialog.alert).not.toHaveBeenCalled();
  expect(page.data.messages).toEqual([]);
});

test.each([new Error('SDK: file size exceeded; private response'),
  { errMsg: 'callFunction:fail private response' },
  new CloudError('NETWORK', 'HTTP 500 private response')])('保存异常不直接外显 SDK 原文，保留照片与草稿供重试：%p', async error => {
  (repository.addRecord as jest.Mock).mockRejectedValueOnce(error);
  page._visible = true;
  jest.spyOn(repository, 'cloudFileIds').mockReturnValue([]);
  const photos = ['/tmp/jd-user-data/photo.jpg'];
  page.data.messages = [{ id: 'draft', role: 'ai', kind: 'draft', draft: { key: 'draft', petId: a.id,
    date: today(), text: '演示照片', tags: [], photos: photos.slice(), status: 'pending' } }];
  await page.onCardSave({ detail: { key: 'draft' } });
  expect(Dialog.alert).toHaveBeenLastCalledWith(expect.objectContaining({ content: '暂时无法确认保存结果，请稍后重试。草稿和照片已保留。' }));
  expect(page.data.messages[0].draft).toMatchObject({ status: 'failed', photos, text: '演示照片' });
  expect(store.getRecords(a.id)).toHaveLength(0);
  await page.onCardSave({ detail: { key: 'draft' } });
  expect(page.data.messages[0].draft.status).toBe('saved');
  expect(store.getRecords(a.id)[0].photos).toEqual(photos);
});

test('草稿和日记保留未整理的完整输入，编辑草稿不会改写原文', async () => {
  run.mockResolvedValueOnce({ ...result('已整理'), drafts: [{ petId: a.id, date: today(), text: '点点洗澡', tags: ['洗澡'], photos: [] }] });
  page.data.inputValue = '  今天给点点洗澡了，乖乖的！\n';
  await page.onSend();
  const draft = page.data.messages.find((m: any) => m.draft).draft;
  expect(draft.rawInput.text).toBe('  今天给点点洗澡了，乖乖的！\n');
  page.data.editorKey = draft.key;
  page.onEditorConfirm({ detail: { petId: a.id, date: today(), text: '补充整理结果', photos: [] } });
  await page.onCardSave({ detail: { key: draft.key } });
  const rec = store.getRecords(a.id)[0];
  expect(rec.text).toBe('补充整理结果');
  expect(rec.rawInput!.text).toBe('  今天给点点洗澡了，乖乖的！\n');
});
test('JSON 查询不能被模型的日期和次数覆盖', async () => {
  store.addRecord({ petId: a.id, date: today(), text: '驱虫', tags: ['医疗'], photos: [] });
  run.mockRejectedValueOnce(new Error('工具不支持'));
  json.mockResolvedValueOnce({ reply: '2020年驱虫了99次', draft: null, query: { eventType: 'deworming', mode: 'count' } });
  await page.replyByAI('这个月驱虫几次', [], a);
  expect(page.data.messages[0].text).toContain('共 1 条');
  expect(page.data.messages[0].text).not.toContain('99次');
});
test('旧失败消息重试不会删掉后续对话', () => {
  page.data.messages = [{ id: 'fail', role: 'ai', kind: 'text', retry: true, sourceText: '旧问题' },
    { id: 'new', role: 'user', kind: 'text', text: '新问题' }];
  page.onRetry({ currentTarget: { dataset: { id: 'fail', text: '旧问题' } } });
  expect(page.data.messages).toHaveLength(2);
  expect(run).not.toHaveBeenCalled();
});
// 新契约：是否记录由模型判断（出错也只是多一张卡），用户点不点「保存」才决定入不入库
test('JSON 模型给了草稿就出卡，但没点保存不入日记', async () => {
  run.mockRejectedValueOnce(new Error('不支持工具'));
  json.mockResolvedValueOnce({ reply: '已记录', draft: { date: today(), text: '驱虫了', tags: ['医疗'] }, query: null });
  await page.replyByAI('今天该不该驱虫？', [], a);
  expect(page.data.messages.some((m: any) => m.kind === 'draft')).toBe(true);
  expect(store.getRecords(a.id)).toHaveLength(0);
});

test('查询回复进入下一轮上下文，跨轮指代能看到事实', async () => {
  page.data.messages = [{ id: 'query', role: 'ai', kind: 'query', text: '上次洗澡是昨天', refs: [] }];
  run.mockResolvedValueOnce(result('好的'));
  await page.replyByAI('那需要再洗吗', [], a);
  expect(run.mock.calls[0][2].history[0].content).toBe('上次洗澡是昨天');
});

test('同步串行使用上次返回的版本，不以旧版本提交 AI 回复', async () => {
  store.setCloudSession({ userId: 'u', familyId: 'f' });
  page._session = sessions.newSession();
  page.data.messages = [{ id: 'user', role: 'user', kind: 'text', text: '今天洗澡了', time: Date.now() }];
  page._session.messages = page.data.messages;
  const first = deferred();
  const snapshots: any[] = [];
  const push = jest.spyOn(sessions, 'pushSession').mockImplementation(async (_pet, s) => {
    snapshots.push(JSON.parse(JSON.stringify(s)));
    if (snapshots.length === 1) return first.promise;
    return { ...s, id: 'server-id', version: 2 };
  });
  const savingUser = page.syncSession();
  await Promise.resolve(); await Promise.resolve();
  page.data.messages = page.data.messages.concat({ id: 'ai', role: 'ai', kind: 'text', text: '好的', time: Date.now() });
  page._session.messages = page.data.messages;
  const savingAI = page.syncSession();
  expect(push).toHaveBeenCalledTimes(1);
  first.resolve({ ...page._session, id: 'server-id', version: 1 });
  await Promise.all([savingUser, savingAI]);
  expect(snapshots[1].id).toBe('server-id');
  expect(snapshots[1].version).toBe(1);
  expect(snapshots[1].messages).toHaveLength(2);
  expect(page.data.messages).toHaveLength(2);
});

test('旧话题同步迟到，不能覆盖正在聊的新话题', async () => {
  store.setCloudSession({ userId: 'u', familyId: 'f' });
  page._session = sessions.newSession();
  const old = page._session;
  const pending = deferred();
  jest.spyOn(sessions, 'pushSession').mockReturnValueOnce(pending.promise);
  const saving = page.syncSession();
  await Promise.resolve(); await Promise.resolve();
  page._session = sessions.newSession();
  const current = page._session;
  page.data.messages = [{ id: 'new', role: 'user', kind: 'text', text: '新话题', time: Date.now() }];
  pending.resolve({ ...old, id: 'old-server', version: 1 });
  await saving;
  expect(page._session).toBe(current);
  expect(page.data.sessionId).toBe('');
  expect(page.data.messages[0].text).toBe('新话题');
});

test('同步失败后持久保留未同步标志，成功重试才清除', async () => {
  store.setCloudSession({ userId: 'u', familyId: 'f' });
  page._session = { ...sessions.newSession(), id: 's', version: 1, messages: [] };
  page.data.sessionId = 's'; page.data.sessionVersion = 1;
  const push = jest.spyOn(sessions, 'pushSession').mockRejectedValueOnce(new CloudError('CONFLICT', '冲突'));
  await page.syncSession();
  expect(sessions.loadLocalSession(a.id)!.dirty).toBe(true);
  push.mockImplementation(async (_pet, s) => ({ ...s, version: 2, dirty: false }));
  await page.syncSession();
  expect(sessions.loadLocalSession(a.id)!.dirty).toBe(false);
});

test('旧话题标题迟到不会写到新话题', async () => {
  const pending = deferred();
  jest.spyOn(sessions, 'generateTitle').mockReturnValueOnce(pending.promise);
  page._session = { ...sessions.newSession(), messages: [{ id: 'u', role: 'user', kind: 'text', text: '旧话题', time: Date.now() }] };
  const generating = page.maybeGenerateTitle();
  page._session = sessions.newSession();
  pending.resolve('旧话题的标题');
  await generating;
  expect(page._session.title).toBe('');
});

test('编辑已同步草稿的照片后，只保存保留图片和新图片', async () => {
  store.setCloudSession({ userId: 'u', familyId: 'f' });
  page.data.messages = [{ id: 'd', role: 'ai', kind: 'draft', draft: {
    key: 'd', petId: a.id, date: today(), text: '洗澡', tags: [],
    photos: ['https://old/a', 'https://old/b'], photoIds: ['cloud://a', 'cloud://b'], status: 'pending',
  } }];
  page.data.editorKey = 'd';
  page.onEditorConfirm({ detail: { petId: a.id, date: today(), text: '洗澡', photos: ['https://old/b', '/tmp/jd-user-data/new.jpg'] } });
  expect(page.data.messages[0].draft.photoIds).toEqual(['cloud://b', '']);
  await page.onCardSave({ detail: { key: 'd' } });
  expect(store.getRecords(a.id)[0].photos).toEqual(['cloud://b', '/tmp/jd-user-data/new.jpg']);
  expect(page.data.messages[0].draft.status).toBe('saved');
});

describe('发送之前显示新话题边界', () => {
  function seed(age = 0) {
    const session = { ...sessions.newSession(), id: 'previous', messages: [
      { id: 'last', role: 'ai' as const, kind: 'text' as const, text: '之前的回复', time: Date.now() - age },
    ] };
    sessions.saveLocalSession(a.id, session);
    jest.spyOn(page, 'finalizeSession').mockResolvedValue(undefined);
    return session;
  }

  test('打开超过30分钟的话题立即显示分隔符，保留未发送内容，重复打开不重复分隔', async () => {
    seed(SESSION_GAP_MS + 1);
    page.data.inputValue = '还没发出去';
    page.data.attachments = ['/local/photo.jpg'];
    await page.onShow();
    expect(page.data.messages).toHaveLength(1);
    expect(page.data.messages[0].kind).toBe('divider');
    expect(page.data.messages[0].text).toContain('已间隔30分钟');
    expect(page.data.contextCount).toBe(0);
    expect(page.data.inputValue).toBe('还没发出去');
    expect(page.data.attachments).toEqual(['/local/photo.jpg']);
    expect(run).not.toHaveBeenCalled();
    expect(page.finalizeSession).toHaveBeenCalledTimes(1);
    const dividerId = page.data.messages[0].id;
    await page.onShow();
    expect(page.data.messages[0].id).toBe(dividerId);
    expect(page.finalizeSession).toHaveBeenCalledTimes(1);
  });

  test('停留在页面，满30分钟即显示分隔符，随后发送不带旧上下文', async () => {
    seed();
    await page.onShow();
    jest.advanceTimersByTime(SESSION_GAP_MS - 1);
    expect(page.data.messages[0].kind).toBe('text');
    jest.advanceTimersByTime(1);
    expect(page.data.messages[0].kind).toBe('divider');
    expect(buildHistory(page.data.messages)).toEqual([]);
    run.mockResolvedValueOnce(result('新的回复'));
    page.data.inputValue = '新话题的问题';
    await page.onSend();
    expect(run.mock.calls[0][2].history).toEqual([]);
    expect(page.data.messages.filter((m: any) => m.kind === 'divider')).toHaveLength(1);
  });

  test('新回复会重置倒计时，不在原定截止时间切走', async () => {
    seed();
    await page.onShow();
    jest.advanceTimersByTime(20 * 60 * 1000);
    run.mockResolvedValueOnce(result('新的回复'));
    page.data.inputValue = '继续聊';
    await page.onSend();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(page.data.messages.some((m: any) => m.kind === 'divider')).toBe(false);
    jest.advanceTimersByTime(20 * 60 * 1000);
    expect(page.data.messages[0].kind).toBe('divider');
  });

  test.each(['onHide', 'onUnload'])('%s 清理计时，返回页面时再提前显示边界', async (lifecycle) => {
    seed();
    (wx as any).hideKeyboard = jest.fn();
    await page.onShow();
    page[lifecycle]();
    expect(page._idleTimer).toBeNull();
    jest.advanceTimersByTime(SESSION_GAP_MS + 1);
    expect(page.data.messages[0].kind).toBe('text');
    await page.onShow();
    expect(page.data.messages[0].kind).toBe('divider');
  });

  test('回复生成期间不切走，完成回复后重新计时', async () => {
    seed();
    await page.onShow();
    const pending = deferred();
    run.mockReturnValueOnce(pending.promise);
    const replying = page.replyByAI('继续聊', [], a, undefined, page.data.messages.slice());
    jest.advanceTimersByTime(SESSION_GAP_MS + 1);
    expect(page.data.messages[0].kind).toBe('text');
    expect(page.data.aiThinking).toBe(true);
    pending.resolve(result('回复完成'));
    await replying;
    expect(page.data.messages.some((m: any) => m.kind === 'divider')).toBe(false);
    jest.advanceTimersByTime(SESSION_GAP_MS);
    expect(page.data.messages[0].kind).toBe('divider');
  });

  test('主动从目录打开旧话题可以继续，从打开时重新计时', async () => {
    seed();
    await page.onShow();
    const old = { ...sessions.newSession(), id: 'old-topic', messages: [
      { id: 'old', role: 'user' as const, kind: 'text' as const, text: '几天前的话题', time: Date.now() - 86400000 },
    ] };
    jest.spyOn(sessions, 'readSession').mockResolvedValueOnce(old);
    await page.onOpenSession({ currentTarget: { dataset: { id: old.id } } });
    expect(page.data.sessionId).toBe(old.id);
    expect(page.data.messages[0].text).toBe('几天前的话题');
    jest.advanceTimersByTime(SESSION_GAP_MS - 1);
    expect(page.data.sessionId).toBe(old.id);
    jest.advanceTimersByTime(1);
    expect(page.data.messages[0].kind).toBe('divider');
  });

  test('读取旧话题期间暂停超时切换，避免读完因当前话题已变化而打不开', async () => {
    seed(SESSION_GAP_MS - 1000);
    await page.onShow();
    const pending = deferred();
    jest.spyOn(sessions, 'readSession').mockReturnValueOnce(pending.promise);
    const opening = page.onOpenSession({ currentTarget: { dataset: { id: 'old-topic' } } });
    jest.advanceTimersByTime(2000);
    expect(page.data.sessionId).toBe('previous');
    pending.resolve({ ...sessions.newSession(), id: 'old-topic', messages: [
      { id: 'old', role: 'user', kind: 'text', text: '旧话题内容', time: Date.now() - 86400000 },
    ] });
    await opening;
    expect(page.data.sessionId).toBe('old-topic');
    expect(page.data.messages[0].text).toBe('旧话题内容');
    expect(page._idleTimer).not.toBeNull();
  });

  test('编辑记录时不被超时打断，关闭编辑器后显示新话题边界', async () => {
    const session = seed();
    session.messages.push({ id: 'draft', role: 'ai', kind: 'draft', text: '', time: Date.now(), draft: {
      key: 'draft', petId: a.id, date: today(), text: '洗澡', tags: [], photos: [], status: 'pending',
    } } as any);
    sessions.saveLocalSession(a.id, session);
    await page.onShow();
    page.onCardEdit({ detail: { key: 'draft' } });
    jest.advanceTimersByTime(SESSION_GAP_MS + 1);
    expect(page.data.editorVisible).toBe(true);
    expect(page.data.messages[0].kind).toBe('text');
    page.onEditorClose();
    expect(page.data.messages[0].kind).toBe('divider');
  });
});
