/** 直接调用聊天页的真实事件方法，模拟异步网络和切换事件。 */
import { runAgent } from '../../utils/agent';
import { chatWithModel } from '../../utils/llm';
import * as store from '../../utils/store';
import { RequestToken } from '../../utils/cancellation';
import { today } from '../../utils/date';
import * as sessions from '../../utils/chat-store';
import { SESSION_GAP_MS, buildHistory } from '../../utils/context';

jest.mock('tdesign-miniprogram/action-sheet/index', () => ({ __esModule: true, default: { show: jest.fn() } }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { confirm: () => Promise.reject() } }), { virtual: true });
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
  return { ...actual, addRecord: (input: any) => local.addRecord(input) };
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
  expect(json.mock.calls[0][3]).toBe(token);
  page.onStop();
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
