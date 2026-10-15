/**
 * 微信云开发 AI 通道：重点验证两侧独立性——
 * 1. 云开发模式完全不走 wx.request（不泄漏密钥、不误触自建链路）
 * 2. 版本门槛、中断语义、错误归一化、返回结构兼容
 */
import { cloudAiRequest, isCloudAiSupported, compareVersion, currentSdkVersion, CLOUD_AI_PROVIDER, CLOUD_AI_MODEL, CLOUD_AI_TIMEOUT_MS } from '../../utils/cloud-ai';
import { chatWithModel, chatTurn, isModelReady, testConnection, summarizeTitle, summarizeSession } from '../../utils/llm';
import { RequestToken } from '../../utils/cancellation';
import { runAgent } from '../../utils/agent';
import { savePet, addRecord, getRecords, clearAll } from '../../utils/store';

const cloudCfg = { provider: '微信云开发 AI', baseUrl: '', apiKey: '', model: 'hy3', source: 'cloud' as const };
const httpCfg = { provider: 'DeepSeek', baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', source: 'custom' as const };
const context = { petName: '咪咪', species: '猫', today: '2026-10-15', history: [], records: [] };

function stubCloudAi(handler: (data: any) => any) {
  const created: string[] = [];
  const wxStub = (global as any).__wxStub;
  wxStub.cloud = {
    init: jest.fn(),
    extend: { AI: { createModel: (provider: string) => { created.push(provider); return { generateText: handler }; } } },
  };
  wxStub.getAppBaseInfo = () => ({ SDKVersion: '3.15.1' });
  return created;
}

beforeEach(() => {
  stubCloudAi(async () => ({ choices: [{ message: { content: '{"reply":"你好","draft":null,"query":null}' } }] }));
});

test.each([
  ['3.15.1', '3.15.1', 0],
  ['3.6.3', '3.15.1', -1],
  ['3.20.0', '3.15.1', 1],
  ['4.0.0', '3.15.1', 1],
])('版本号按段比较：%s vs %s', (a, b, expected) => {
  expect(compareVersion(a, b)).toBe(expected);
});

test.each(['3.6.3', '2.30.0', ''])('基础库 %s 低于门槛时判定不支持', (version) => {
  expect(isCloudAiSupported(version)).toBe(false);
});

test.each(['3.15.1', '3.20.0', '4.1.0'])('基础库 %s 满足门槛', (version) => {
  expect(isCloudAiSupported(version)).toBe(true);
});

test('未取到版本号时按不支持处理，避免线上旧版微信走进不可用分支', () => {
  (global as any).__wxStub.getAppBaseInfo = () => ({});
  expect(currentSdkVersion()).toBe('');
  expect(isCloudAiSupported()).toBe(false);
});

test('微信版本过低直接失败，不发起任何云调用', async () => {
  (global as any).__wxStub.getAppBaseInfo = () => ({ SDKVersion: '3.6.3' });
  await expect(cloudAiRequest({ messages: [] })).rejects.toThrow('云开发 AI 需要基础库');
});

test('云开发配置不需要密钥即可判定就绪，自建配置仍要校验三项', () => {
  expect(isModelReady(cloudCfg)).toBe(true);
  expect(isModelReady(httpCfg)).toBe(true);
  expect(isModelReady({ provider: '', baseUrl: '', apiKey: '', model: '' })).toBe(false);
  expect(isModelReady({ provider: '', baseUrl: '', apiKey: '', model: '', source: 'cloud' })).toBe(true);
});

test('使用 hunyuan-v3 通道调用 hy3 模型，并显式关闭深度思考', async () => {
  let sent: any;
  const created = stubCloudAi(async (data: any) => {
    sent = data;
    return { choices: [{ message: { content: 'hi' } }] };
  });
  await cloudAiRequest({ messages: [{ role: 'user', content: '你好' }] });
  expect(created).toEqual([CLOUD_AI_PROVIDER]);
  expect(sent.model).toBe(CLOUD_AI_MODEL);
  expect(sent.thinking).toEqual({ type: 'disabled' });
});

test('缺少 model 字段时回落到默认模型，不让云侧收到 undefined', async () => {
  let sent: any;
  stubCloudAi(async (data: any) => {
    sent = data;
    return { choices: [{ message: { content: 'hi' } }] };
  });
  await cloudAiRequest({ messages: [] });
  expect(sent.model).toBe(CLOUD_AI_MODEL);
});

test('兼容 { text } 形态的返回，统一成 chat.completion 结构', async () => {
  stubCloudAi(async () => ({ text: '你好呀', usage: { total_tokens: 3 } }));
  const data = await cloudAiRequest({ messages: [] });
  expect(data.choices[0].message.content).toBe('你好呀');
  expect(data.usage.total_tokens).toBe(3);
});

test.each([
  ['EXCEED_CONCURRENT_REQUEST_LIMIT', '稍后重试'],
  ['insufficient quota', '额度不足'],
  ['model not enabled', '尚未在云开发控制台开通'],
  ['network error', '云开发 AI 调用失败'],
])('错误信息归一化为可操作提示：%s', async (message, expected) => {
  stubCloudAi(async () => { throw new Error(message); });
  await expect(cloudAiRequest({ messages: [] })).rejects.toThrow(expected);
});

test('返回为空时显式失败，不伪装成空回复', async () => {
  stubCloudAi(async () => ({ choices: [] }));
  await expect(cloudAiRequest({ messages: [] })).rejects.toThrow('返回为空');
});

test('generateText 没有 abort 句柄：停止后丢弃迟到结果', async () => {
  stubCloudAi(async () => ({ choices: [{ message: { content: '迟到的回复' } }] }));
  const token = new RequestToken();
  const pending = cloudAiRequest({ messages: [] }, token);
  token.cancel();
  await expect(pending).rejects.toThrow('已停止生成');
});

test('已停止时不把网络错误抛给上层', async () => {
  stubCloudAi(async () => { throw new Error('EXCEED_CONCURRENT_REQUEST_LIMIT'); });
  const token = new RequestToken();
  const pending = cloudAiRequest({ messages: [] }, token);
  token.cancel();
  await expect(pending).rejects.toThrow('已停止生成');
});

test.each(['chatWithModel', 'chatTurn', 'testConnection'])('%s 在云开发模式下不走 wx.request', async (fn) => {
  const request = jest.fn((opts: any) => opts.success({ statusCode: 200, data: { choices: [{ message: { content: '{"reply":"你好","draft":null,"query":null}' } }] } }));
  (global as any).__wxStub.request = request;
  stubCloudAi(async () => ({ choices: [{ message: { role: 'assistant', content: '{"reply":"你好","draft":null,"query":null}' } }] }));
  if (fn === 'chatWithModel') await chatWithModel(cloudCfg, '你好', context);
  if (fn === 'chatTurn') await chatTurn(cloudCfg, [], []);
  if (fn === 'testConnection') await testConnection(cloudCfg);
  expect(request).not.toHaveBeenCalled();
});

test('自建 API 仍走 wx.request，不受云开发分支影响', async () => {
  const request = jest.fn((opts: any) => opts.success({ statusCode: 200, data: { choices: [{ message: { content: '{"reply":"你好","draft":null,"query":null}' } }] } }));
  (global as any).__wxStub.request = request;
  await testConnection(httpCfg);
  expect(request).toHaveBeenCalled();
});

test('云开发模型不支持 response_format 时自动降级重试一次', async () => {
  const attempts: any[] = [];
  stubCloudAi(async (data: any) => {
    attempts.push(data);
    if (data.response_format) throw new Error('unsupported response_format');
    return { choices: [{ message: { content: '{"reply":"你好","draft":null,"query":null}' } }] };
  });
  const out = await chatWithModel(cloudCfg, '你好', context);
  expect(out.reply).toBe('你好');
  expect(attempts).toHaveLength(2);
  expect(attempts[1].response_format).toBeUndefined();
});

test('自建 API 的 JSON 模式保持单次请求，不做无谓重试', async () => {
  const attempts: any[] = [];
  (global as any).__wxStub.request = (opts: any) => {
    attempts.push(opts.data);
    opts.success({ statusCode: 200, data: { choices: [{ message: { content: '{"reply":"你好","draft":null,"query":null}' } }] } });
  };
  await chatWithModel(httpCfg, '你好', context);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].response_format).toEqual({ type: 'json_object' });
});

test('云开发模式下停止生成不会被重试逻辑复活', async () => {
  stubCloudAi(async () => { throw new Error('unsupported response_format'); });
  const token = new RequestToken();
  const pending = chatWithModel(cloudCfg, '你好', context, token);
  token.cancel();
  await expect(pending).rejects.toThrow('已停止生成');
});

test('停止立即结束等待，SDK 永不返回也不会卡住；迟到失败被消费', async () => {
  let rejectSdk!: (error: any) => void;
  stubCloudAi(() => new Promise((_, reject) => { rejectSdk = reject; }));
  const token = new RequestToken();
  const pending = cloudAiRequest({ messages: [] }, token);
  token.cancel();
  await expect(pending).rejects.toThrow('已停止生成');
  rejectSdk({ errMsg: 'late failure' });
  await Promise.resolve();
});

test('无响应时按本地超时退出，迟到成功不恢复请求', async () => {
  jest.useFakeTimers();
  try {
    let resolveSdk!: (data: any) => void;
    stubCloudAi(() => new Promise(resolve => { resolveSdk = resolve; }));
    const pending = cloudAiRequest({ messages: [] });
    const checked = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    jest.advanceTimersByTime(CLOUD_AI_TIMEOUT_MS);
    await checked;
    resolveSdk({ choices: [{ message: { content: 'late' } }] });
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test.each([
  [{ errCode: 'EXCEED_CONCURRENT_REQUEST_LIMIT' }, 'CONCURRENT'],
  [{ errMsg: 'insufficient quota' }, 'QUOTA'],
  [{ errMsg: 'insufficient permissions' }, 'AUTH'],
  [{ code: 'PERMISSION_DENIED', message: 'response_format unsupported' }, 'AUTH'],
  [{ errMsg: 'network error' }, 'CLOUD_AI'],
])('JSON 降级不重复请求额度、权限、并发或网络错误：%j', async (error, code) => {
  const generate = jest.fn().mockRejectedValue(error);
  stubCloudAi(generate);
  await expect(chatWithModel(cloudCfg, '你好', context)).rejects.toMatchObject({ code });
  expect(generate).toHaveBeenCalledTimes(1);
});

test('基础库满足但 API 缺失时有明确提示；已取消请求完全不调用 SDK', async () => {
  (wx as any).cloud.extend = {};
  await expect(cloudAiRequest({})).rejects.toThrow('不支持云开发 AI');
  const generate = jest.fn(); stubCloudAi(generate);
  const token = new RequestToken(); token.cancel();
  await expect(cloudAiRequest({}, token)).rejects.toThrow('已停止生成');
  expect(generate).not.toHaveBeenCalled();
});

test.each([{}, { choices: [{}] }, { choices: [{ message: { content: '  ' } }] }])('畸形或空白 completion 不能伪装成成功：%j', async raw => {
  stubCloudAi(async () => raw);
  await expect(cloudAiRequest({})).rejects.toMatchObject({ code: 'EMPTY' });
});

test('SDK 以响应体返回错误时也保留可操作的错误分类', async () => {
  stubCloudAi(async () => ({ error: { code: 'insufficient_quota' } }));
  await expect(cloudAiRequest({})).rejects.toMatchObject({ code: 'QUOTA' });
});

test('云函数与 AI 共用同一次云环境初始化', async () => {
  stubCloudAi(async () => ({ choices: [{ message: { content: '你好' } }] }));
  (wx as any).cloud.callFunction = jest.fn().mockResolvedValue({ result: { ok: true, data: '已连接' } });
  let transport: any, ai: any;
  jest.isolateModules(() => {
    transport = require('../../utils/cloud');
    ai = require('../../utils/cloud-ai');
  });
  expect(await transport.callCloud('test')).toBe('已连接');
  await ai.cloudAiRequest({ messages: [] });
  expect((wx as any).cloud.init).toHaveBeenCalledTimes(1);
});

test('话题标题与摘要使用相同云开发传输', async () => {
  const request = jest.fn(); (wx as any).request = request;
  const generate = jest.fn().mockResolvedValue({ choices: [{ message: { content: '演示主题' } }] });
  stubCloudAi(generate);
  expect(await summarizeTitle(cloudCfg, ['合成文字'])).toBe('演示主题');
  expect(await summarizeSession(cloudCfg, ['合成文字'])).toBe('演示主题');
  expect(generate).toHaveBeenCalledTimes(2); expect(request).not.toHaveBeenCalled();
});

test('真实 agent 经云开发通道执行工具和回传 role:tool，生成草稿但不静默写入', async () => {
  clearAll();
  try {
    const pet = savePet({ name: '演示猫', species: '猫' });
    const sourceText = '2025年10月1日领养了演示猫';
    const turns = [{ content: null, tool_calls: [{ id: 'draft-1', type: 'function', function: {
      name: 'create_draft_record', arguments: JSON.stringify({ sourceText, text: '领养了演示猫', tags: ['领养'] }),
    } }] }, { content: '整理好了' }];
    const sent: any[] = [];
    stubCloudAi(async data => { sent.push(JSON.parse(JSON.stringify(data))); return { choices: [{ message: turns.shift() }] }; });
    const result = await runAgent(cloudCfg, sourceText, { pet, history: [], photos: [] });
    expect(result.drafts[0]).toMatchObject({ date: '2025-10-01', text: '领养了演示猫' });
    expect(getRecords(pet.id)).toEqual([]);
    expect(sent[0].tools.map((tool: any) => tool.function.name)).toContain('create_draft_record');
    expect(sent[1].messages.some((msg: any) => msg.role === 'tool' && msg.tool_call_id === 'draft-1')).toBe(true);
  } finally { clearAll(); }
});

test('云开发工具查询引用真实记录，不混入其他事件', async () => {
  clearAll();
  try {
    const pet = savePet({ name: '演示猫', species: '猫' });
    const target = addRecord({ petId: pet.id, date: '2025-10-01', text: '领养了演示猫', tags: ['领养'], photos: [] });
    addRecord({ petId: pet.id, date: '2026-06-01', text: '驱虫了', tags: ['驱虫'], photos: [] });
    const turns = [{ content: '', tool_calls: [{ id: 'query-1', function: { name: 'query_records',
      arguments: JSON.stringify({ eventType: 'adoption', mode: 'latest' }) } }] }, { content: '查到了' }];
    stubCloudAi(async () => ({ choices: [{ message: turns.shift() }] }));
    const result = await runAgent(cloudCfg, '哪天领养的演示猫？', { pet, history: [], photos: [] });
    expect(result.reply).toContain('2025-10-01');
    expect(result.refs.map(ref => ref.recordId)).toEqual([target.id]);
  } finally { clearAll(); }
});
