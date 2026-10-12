/** 直接调用聊天页的真实事件方法，模拟异步网络和切换事件。 */
import { runAgent } from '../../utils/agent';
import { chatWithModel } from '../../utils/llm';
import * as store from '../../utils/store';
import { RequestToken } from '../../utils/cancellation';
import { today } from '../../utils/date';

jest.mock('tdesign-miniprogram/action-sheet/index', () => ({ __esModule: true, default: { show: jest.fn() } }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
jest.mock('../../utils/agent', () => ({ runAgent: jest.fn(), AbortedError: jest.requireActual('../../utils/cancellation').AbortedError }));
jest.mock('../../utils/llm', () => ({ chatWithModel: jest.fn(), isModelReady: () => true }));
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
test('不合法 JSON 继续进入明确标识的本地兜底，重试保留照片', async () => {
  run.mockRejectedValueOnce(new Error('工具不支持'));
  json.mockRejectedValueOnce(new Error('模型没有返回有效 JSON'));
  const photos = ['/tmp/jd-user-data/photo.jpg'];
  await page.replyByAI('今天洗澡了', photos, a);
  const notice = page.data.messages.find((m: any) => m.retry);
  expect(notice.demo).toBe(true);
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
test('重复点击已保存卡片不能新增重复记录', () => {
  page.data.messages = [{ id: 'draft', role: 'ai', kind: 'draft', draft: { key: 'draft', petId: a.id, date: today(), text: '洗澡', tags: ['洗澡'], photos: [], status: 'pending' } }];
  page.onCardSave({ detail: { key: 'draft' } });
  page.onCardSave({ detail: { key: 'draft' } });
  expect(store.getRecords(a.id)).toHaveLength(1);
});
test('JSON 查询不能被模型的日期和次数覆盖', async () => {
  store.addRecord({ petId: a.id, date: today(), text: '驱虫', tags: ['医疗'], photos: [] });
  run.mockRejectedValueOnce(new Error('工具不支持'));
  json.mockResolvedValueOnce({ reply: '2020年驱虫了99次', draft: null, query: { eventType: 'vaccination', mode: 'count' } });
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
test('JSON 模型误把咨询变成草稿，也不能弹出记录卡', async () => {
  run.mockRejectedValueOnce(new Error('不支持工具'));
  json.mockResolvedValueOnce({ reply: '已记录', draft: { date: today(), text: '驱虫了', tags: ['医疗'] }, query: null });
  await page.replyByAI('今天该不该驱虫？', [], a);
  expect(page.data.messages.some((m: any) => m.kind === 'draft')).toBe(false);
  expect(store.getRecords(a.id)).toHaveLength(0);
});
