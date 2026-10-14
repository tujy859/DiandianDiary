import { chatTurn, chatWithModel, extractJson } from '../../utils/llm';
import { RequestToken, AbortedError } from '../../utils/cancellation';
const cfg = { provider: 'test', baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'm' };
const context = { petName: '咪咪', species: '猫', today: '2026-10-12', history: [], records: [] };

test('JSON 模式具有独立提示和 response_format，不依赖普通文字猜测', async () => {
  let request: any;
  (global as any).__wxStub.request = (opts: any) => {
    request = opts;
    opts.success({ statusCode: 200, data: { choices: [{ message: { content: '{"reply":"你好","draft":null,"query":null}' } }] } });
  };
  expect((await chatWithModel(cfg, '你好', context)).reply).toBe('你好');
  expect(request.data.response_format).toEqual({ type: 'json_object' });
  expect(request.data.messages[0].content).toContain('只输出一个 JSON');
  expect(request.data.messages[0].content).toContain('"startDate":"2026-10-01"');
  expect(request.data.messages[0].content).toContain('"endDateExclusive":"2026-11-01"');
  expect(request.url).toBe('https://example.test/v1/chat/completions');
});
test.each([
  '已帮你记录了', '{坏JSON}', '{"reply":"hi"}', '说明：{"reply":"hi","draft":null,"query":null}',
  '{"reply":"","draft":{"date":"2026-02-30","text":"洗澡","tags":[]},"query":null}',
  '{"reply":"","draft":null,"query":{"limit":-1}}',
  '{"reply":"","draft":null,"query":{"petId":"other"}}',
  '{"reply":"","draft":null,"query":{"startDate":"2026-11-01","endDateExclusive":"2026-10-01"}}',
])('结构不符合约定必须显式失败：%s', (content) => expect(() => extractJson(content)).toThrow());
test('接受完整 JSON 代码块，保持模糊草稿日期为 null', () => {
  expect(extractJson('```json\n{"reply":"待确认","draft":{"date":null,"text":"洗澡","tags":["洗澡"]},"query":null}\n```').draft!.date).toBeNull();
});
test('JSON 降级支持原文证据及分页参数，供共用执行器验证', () => {
  const out = extractJson(JSON.stringify({ reply: '', draft: { text: '洗澡了', sourceText: '昨天洗澡了', date: null, tags: [] }, query: { offset: 3, limit: 2 } }));
  expect(out.draft!.sourceText).toBe('昨天洗澡了');
  expect(out.query!.offset).toBe(3);
});
test('工具参数 JSON 损坏触发降级，不当作空参数执行全量查询', async () => {
  (global as any).__wxStub.request = (opts: any) => opts.success({ statusCode: 200, data: { choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'query_records', arguments: '{broken' } }] } }] } });
  await expect(chatTurn(cfg, [], [])).rejects.toThrow('工具参数');
});
test.each(['tool', 'json'])('%s 请求取消会真正调用 RequestTask.abort，迟到成功不会复活请求', async (mode) => {
  let options: any;
  const abort = jest.fn();
  (global as any).__wxStub.request = (opts: any) => { options = opts; return { abort }; };
  const token = new RequestToken();
  const pending = mode === 'tool' ? chatTurn(cfg, [], [], token) : chatWithModel(cfg, '你好', context, token);
  const assertion = expect(pending).rejects.toBeInstanceOf(AbortedError);
  token.cancel();
  options.success({ statusCode: 200, data: { choices: [{ message: { content: '{"reply":"late","draft":null,"query":null}' } }] } });
  await assertion;
  expect(abort).toHaveBeenCalledTimes(1);
});
test('取消已结束的请求不误伤其他请求', async () => {
  const abort = jest.fn();
  (global as any).__wxStub.request = (opts: any) => { opts.success({ statusCode: 200, data: { choices: [{ message: { content: 'hi' } }] } }); return { abort }; };
  const token = new RequestToken();
  await chatTurn(cfg, [], [], token);
  token.cancel();
  expect(abort).not.toHaveBeenCalled();
});
