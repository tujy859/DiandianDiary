/** 正式聊天 Page、真实 agent/HTTP 协议和云业务服务联测；模型与云传输使用内存演示实现。 */
import * as store from '../../utils/store';
import * as repo from '../../utils/repository';
import { callCloud, CloudError } from '../../utils/cloud';
import { enableDeveloperMode, disableDeveloperMode } from '../../utils/developer';
import { prepareFlowRun, getFlowRun, executeFlow, cleanupFlowRun, cancelFlowRun, recoverFlowRun, openFlowRun } from '../../utils/flow-test';
import { returnToOriginalFamily } from '../../utils/new-user-test';
import { getDebugTraces } from '../../utils/debug-trace';
import { logoutLocal } from '../../utils/family-state';
import { memoryDatabase } from './helpers/cloud-db';
const { createService } = require('../../cloudfunctions/diaryApi/service');
jest.mock('tdesign-miniprogram/action-sheet/index', () => ({ __esModule: true, default: { show: jest.fn() } }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { confirm: jest.fn() } }), { virtual: true });
jest.mock('../../utils/cloud', () => ({ ...jest.requireActual('../../utils/cloud'), callCloud: jest.fn() }));
jest.mock('../../utils/llm', () => ({ ...jest.requireActual('../../utils/llm'), summarizeTitle: async () => '演示流程', summarizeSession: async () => '合成数据回归' }));
const rpc = callCloud as jest.Mock;
let definition: any, page: any, db: any, service: any, original: store.CloudSession;
let jsonMode = false, broadQuery = false;
beforeAll(() => {
  (global as any).Page = (value: any) => { definition = value; };
  require('../../pages/chat/chat.ts');
});
beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00+08:00') });
  wx.clearStorageSync(); jest.clearAllMocks(); jsonMode = false; broadQuery = false;
  db = memoryDatabase(); let token = 0;
  service = createService({ db, storage: {}, token: () => (++token).toString().padStart(48, 'a') });
  rpc.mockImplementation(async (action, data = {}) => {
    try { return await service({ action, data }, { OPENID: 'alice', APPID: 'demo' }); }
    catch (error: any) { throw new CloudError(error.code, error.message); }
  });
  await repo.connectCloud(); original = store.getCloudSession()!;
  store.saveModelConfig({ provider: '自定义', baseUrl: 'https://model.example.invalid', apiKey: 'demo-key', model: 'demo' });
  enableDeveloperMode();
  wx.request = (options: any) => {
    if (jsonMode && options.data.tools) { options.success({ statusCode: 400, data: {} }); return; }
    const messages = options.data.messages, text = messages.filter((m: any) => m.role === 'user').pop().content;
    let message: any = { content: '整理好了' };
    const query = /什么时候/.test(text);
    const args = query ? (broadQuery ? { purpose: 'answer' } : { eventType: text.includes('领养') ? 'adoption' : 'deworming', mode: 'latest' })
      : { sourceText: text, date: text.startsWith('2025') ? '2025-01-01' : text.startsWith('2026') ? '2026-06-01' : '2026-10-14',
        text: text.includes('领养') ? '领养了点点' : text.includes('驱虫') ? '驱虫了' : '和猫玩了', tags: [text.includes('领养') ? '领养' : text.includes('驱虫') ? '驱虫' : '玩耍'] };
    if (jsonMode) message = { content: JSON.stringify({ reply: '', draft: query ? null : args, query: query ? args : null }) };
    else if (messages[messages.length - 1].role !== 'tool') message = { content: '', tool_calls: [{ id: 'demo-call', function: {
      name: query ? 'query_records' : 'create_draft_record', arguments: JSON.stringify(args),
    } }] };
    options.success({ statusCode: 200, data: { choices: [{ message }] } });
  };
});
afterEach(() => { cancelFlowRun(); if (page) page.onUnload(); page = null; jest.restoreAllMocks(); jest.clearAllTimers(); jest.useRealTimers(); });
function chatPage() {
  page = { ...definition, _syncTail: Promise.resolve(), _syncPending: 0, _visible: true, _disposed: false, _scopeEpoch: store.getCloudSessionEpoch(),
    data: JSON.parse(JSON.stringify(definition.data)) };
  page.setData = (patch: any) => Object.entries(patch).forEach(([key, value]) => {
    const match = key.match(/^messages\[(\d+)\]\.draft$/);
    if (match) page.data.messages[Number(match[1])].draft = value;
    else page.data[key] = value;
  });
  page.data.currentPet = store.getCurrentPet(); page.data.pets = store.getPets();
  page.syncFlowState(); return page;
}

test.each(['tool', 'json'])('首次发消息云同步先返回 id，不得取消同一话题迟到的 %s 草稿', async mode => {
  await prepareFlowRun(); const instance = chatPage();
  const text = '大概这周一，演示猫玩了玩具';
  let release!: () => void, ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const respond = (options: any) => {
    const messages = options.data.messages;
    const draft = { sourceText: text, text: '演示猫玩了玩具', date: null, tags: ['玩耍'] };
    const message = mode === 'json' ? { content: JSON.stringify({ reply: '', draft, query: null }) }
      : messages[messages.length - 1].role === 'tool' ? { content: '请确认草稿' }
      : { content: '', tool_calls: [{ id: 'demo-first', function: { name: 'create_draft_record', arguments: JSON.stringify(draft) } }] };
    options.success({ statusCode: 200, data: { choices: [{ message }] } });
  };
  let first = true;
  wx.request = (options: any) => {
    if (mode === 'json' && options.data.tools) { options.success({ statusCode: 400, data: {} }); return; }
    if (first) { first = false; release = () => respond(options); ready(); }
    else respond(options);
  };
  expect(instance.data.sessionId).toBe('');
  instance.data.inputValue = text; const sending = instance.onSend();
  await waiting;
  const clientId = instance._session.clientId;
  await instance._syncTail;
  expect(instance.data.sessionId).not.toBe('');
  expect(instance._session.clientId).toBe(clientId);
  release(); await sending; await instance._syncTail;
  expect(instance.data.messages.filter((m: any) => m.draft)).toHaveLength(1);
  expect(instance.data.messages.find((m: any) => m.draft).draft).toMatchObject({ date: null, status: 'pending', text: '演示猫玩了玩具' });
  expect(getDebugTraces().slice(-1)[0].status).toBe('complete');
  expect(db.dump('diaries')).toHaveLength(0);
});

test.each(['tool', 'json', 'omitted'])('正式 Page → agent → 原卡更正 → 确认保存 → 云端重读，模型路径=%s', async mode => {
  const run = await prepareFlowRun(), instance = chatPage();
  const originalText = '今天演示猫在吃饭', correction = '日期不对，应该是25年12月27号';
  const requests: any[] = [];
  wx.request = (options: any) => {
    if (mode === 'json' && options.data.tools) { options.success({ statusCode: 400, data: {} }); return; }
    requests.push(options.data);
    const messages = options.data.messages, text = messages.filter((m: any) => m.role === 'user').pop().content;
    const updating = text === correction;
    const key = instance.data.messages.find((m: any) => m.draft)?.draft.key;
    const args = updating ? { key, sourceText: text, date: '2025-12-27' }
      : { sourceText: text, text: '演示猫在吃饭', date: '2026-10-15', tags: ['吃饭'] };
    let message: any = { content: '这张卡日期本来就正确，已经保存好了' };
    if (mode === 'json') message = { content: JSON.stringify({ reply: message.content, draft: updating ? null : args, query: null, ...(updating ? { update: args } : {}) }) };
    else if (messages[messages.length - 1].role !== 'tool' && !(mode === 'omitted' && updating)) message = { content: '', tool_calls: [{ id: 'demo', function: {
      name: updating ? 'update_draft_record' : 'create_draft_record', arguments: JSON.stringify(args),
    } }] };
    options.success({ statusCode: 200, data: { choices: [{ message }] } });
  };
  instance.data.inputValue = originalText; await instance.onSend(); await instance._syncTail;
  const first = instance.data.messages.find((m: any) => m.draft);
  expect(first.draft.date).toBe('2026-10-15'); const key = first.draft.key;
  instance.data.inputValue = correction; await instance.onSend(); await instance._syncTail;
  const cards = instance.data.messages.filter((m: any) => m.draft);
  expect(cards).toHaveLength(1); expect(cards[0].draft).toMatchObject({ key, date: '2025-12-27', status: 'pending' });
  expect(instance.data.messages[instance.data.messages.length - 1].text).toContain('日期改为2025-12-27');
  expect(db.dump('diaries')).toHaveLength(0);
  expect(requests.some(data => data.messages[0].content.includes(`"key":"${key}"`) && data.messages[0].content.includes('"date":"2026-10-15"'))).toBe(true);
  await instance.onCardSave({ detail: { key } }); await instance._syncTail;
  await repo.refreshCloud();
  const saved = store.getRecords(run.petId);
  expect(saved).toHaveLength(1); expect(saved[0].date).toBe('2025-12-27');
  expect(saved[0].rawInput!.text).toContain(originalText); expect(saved[0].rawInput!.text).toContain(correction);
  expect(cards[0].draft.status).toBe('saved');
});

test.each([false, true])('全流程使用正式发送 / 确认 / 新话题动作，JSON=%s', async fallback => {
  jsonMode = fallback; const run = await prepareFlowRun(); const instance = chatPage();
  await executeFlow(instance.flowAdapter(), true);
  expect(getFlowRun()).toMatchObject({ status: 'complete', next: 8 });
  expect(getFlowRun()!.results.every(r => r.pass)).toBe(true);
  expect(store.getRecords(run.petId).map(r => r.date).sort()).toEqual(['2025-01-01', '2026-06-01', '2026-10-14']);
  expect(getDebugTraces().length).toBeGreaterThan(0);
  expect(db.dump('diaries').filter((d: any) => d.deletedAt === null)).toHaveLength(3);
});
test('逐步执行后暂停；未确认之前没有写库，失败停在现场', async () => {
  await prepareFlowRun(); const instance = chatPage();
  await executeFlow(instance.flowAdapter());
  expect(getFlowRun()).toMatchObject({ status: 'paused', next: 1 });
  expect(getFlowRun()!.records).toHaveLength(1);
  const run = getFlowRun()!;
  const originalReply = instance.replyByAI;
  instance.replyByAI = async function () {
    this.appendMessages([this.toMessage({ kind: 'draft', draft: { petId: run.petId, date: '2025-06-01', text: '驱虫了', tags: [], photos: [], rawInput: { text: '2026年6月1号驱虫了', photos: [], provenance: 'direct' } } }, 'tool')]);
    this.setData({ aiThinking: false }); this._abort = null;
  };
  await executeFlow(instance.flowAdapter(), true); instance.replyByAI = originalReply;
  expect(getFlowRun()).toMatchObject({ status: 'failed', next: 1 });
  expect(store.getRecords(run.petId)).toHaveLength(1);
});
test('查询出现无关引用会令流程失败，不把模型返回成功当成通过', async () => {
  const run = await prepareFlowRun(); const instance = chatPage();
  await executeFlow(instance.flowAdapter()); await executeFlow(instance.flowAdapter()); await executeFlow(instance.flowAdapter());
  broadQuery = true; await executeFlow(instance.flowAdapter(), true);
  expect(getFlowRun()).toMatchObject({ status: 'failed', next: 3 });
  expect(getFlowRun()!.error).toContain('引用'); expect(store.getRecords(run.petId)).toHaveLength(3);
});
test('运行中停止后迟到模型回包不能自动保存后续步骤', async () => {
  const run = await prepareFlowRun(); const instance = chatPage();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(ok => { started = ok; });
  const prior = wx.request;
  wx.request = (options: any) => { release = () => prior(options); started(); };
  const running = executeFlow(instance.flowAdapter(), true); await ready;
  cancelFlowRun(); release(); await running;
  expect(getFlowRun()!.status).toBe('cancelled'); expect(store.getRecords(run.petId)).toEqual([]);
});
test('身份变化阻止迟到保存和旧运行状态恢复', async () => {
  await prepareFlowRun(); const instance = chatPage();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(ok => { started = ok; }); const prior = wx.request;
  wx.request = (options: any) => { release = () => prior(options); started(); };
  const running = executeFlow(instance.flowAdapter(), true); await ready;
  logoutLocal(); release(); await running;
  expect(wx.getStorageInfoSync().keys.some((key: string) => key.startsWith('jd_flow_test_'))).toBe(false);
  expect(db.dump('diaries')).toHaveLength(0);
});
test('清理只删除本轮数据；存在其他手工记录时保留宠物与现场', async () => {
  const run = await prepareFlowRun(); await executeFlow(chatPage().flowAdapter(), true);
  const extra = await repo.addRecord({ petId: run.petId, date: '2026-10-15', text: '手工补充', tags: [], photos: [], clientId: 'extra' });
  await expect(cleanupFlowRun()).rejects.toThrow('其他记录');
  expect(store.getRecords(run.petId).map(r => r.id)).toEqual([extra.id]);
  expect(store.getPets().some(p => p.id === run.petId)).toBe(true);
});
test('清理后复用测试家庭，达到十个家庭也不再新建；每轮使用新宠物', async () => {
  const first = await prepareFlowRun(); await executeFlow(chatPage().flowAdapter(), true); await cleanupFlowRun();
  expect(getFlowRun()).toBeNull();
  for (let i = 0; i < 8; i++) await callCloud('family.create', { name: `演示 ${i}`, clientId: `family-${i}` });
  await returnToOriginalFamily(); expect(store.getCloudSession()).toEqual(original);
  const next = await prepareFlowRun();
  expect(next.familyId).toBe(first.familyId); expect(next.petId).not.toBe(first.petId);
  expect(await callCloud('family.list')).toHaveLength(10);
});
test('准备响应丢失可幂等继续，不重复创建宠物', async () => {
  const prior = rpc.getMockImplementation()!; let lose = true;
  rpc.mockImplementation(async (action, data) => { const result = await prior(action, data); if (action === 'pet.save' && lose) { lose = false; throw new Error('网络响应丢失'); } return result; });
  await expect(prepareFlowRun()).rejects.toThrow('响应丢失');
  const runId = getFlowRun()!.id; await prepareFlowRun();
  expect(getFlowRun()!.id).toBe(runId); expect(db.dump('pets')).toHaveLength(1);
});
test('应用中断不会自动续跑；关闭模式后不能准备或运行', async () => {
  const run = await prepareFlowRun();
  wx.setStorageSync(`jd_flow_test_${run.userId}`, { ...run, status: 'running' });
  expect(recoverFlowRun()!.status).toBe('interrupted');
  disableDeveloperMode(); await expect(prepareFlowRun()).rejects.toThrow('开发者模式');
  expect(getFlowRun()).toBeNull();
});
test('返回原家庭后显式打开测试会刷新作用域，仍可逐步执行', async () => {
  await prepareFlowRun(); await returnToOriginalFamily(); await openFlowRun();
  await executeFlow(chatPage().flowAdapter());
  expect(getFlowRun()).toMatchObject({ next: 1, status: 'paused' });
});

test('准备页面关闭后不继续创建家庭或宠物', async () => {
  const prior = rpc.getMockImplementation()!; let alive = true;
  rpc.mockImplementation(async (action, data) => { const result = await prior(action, data); if (action === 'family.list') alive = false; return result; });
  await expect(prepareFlowRun(() => alive)).rejects.toThrow('停止');
  expect(db.dump('families')).toHaveLength(1); expect(db.dump('pets')).toHaveLength(0);
});

test('测试家庭新增成员后停止执行，不保存演示数据', async () => {
  const run = await prepareFlowRun();
  const family = await db.get('families', run.familyId);
  await db.set('families', run.familyId, { ...family, members: [...family.members, { userId: 'other', role: 'member', joinedAt: Date.now() }] });
  await executeFlow(chatPage().flowAdapter(), true);
  expect(getFlowRun()!.status).toBe('failed'); expect(db.dump('diaries')).toHaveLength(0);
});

test('宠物被手动删除后，可以清理本轮运行信息', async () => {
  const run = await prepareFlowRun(); await repo.removePet(run.petId);
  await cleanupFlowRun(); expect(getFlowRun()).toBeNull();
});

test('创建响应丢失时清理提示先确认结果，不丢掉可幂等重试的请求', async () => {
  const prior = rpc.getMockImplementation()!; let lose = true;
  rpc.mockImplementation(async (action, data) => { const result = await prior(action, data); if (action === 'pet.save' && lose) { lose = false; throw new Error('网络响应丢失'); } return result; });
  await expect(prepareFlowRun()).rejects.toThrow('响应丢失');
  await expect(cleanupFlowRun()).rejects.toThrow('待确认');
  expect(getFlowRun()!.status).toBe('prepare_failed');
  await prepareFlowRun(); expect(db.dump('pets')).toHaveLength(1);
});

test('停止时已发出的保存完成后仍保留其 ID，清理不会留下未知演示记录', async () => {
  const run = await prepareFlowRun(); const prior = rpc.getMockImplementation()!;
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(ok => { started = ok; });
  rpc.mockImplementation(async (action, data) => {
    const result = await prior(action, data);
    if (action === 'diary.save') { started(); await new Promise<void>(ok => { release = ok; }); }
    return result;
  });
  const running = executeFlow(chatPage().flowAdapter(), true); await ready;
  cancelFlowRun(); release(); await running;
  expect(getFlowRun()).toMatchObject({ status: 'cancelled', next: 0 });
  expect(getFlowRun()!.records).toHaveLength(1);
  rpc.mockImplementation(prior); await cleanupFlowRun();
  expect(getFlowRun()).toBeNull(); expect(store.getPets().some(p => p.id === run.petId)).toBe(false);
});
