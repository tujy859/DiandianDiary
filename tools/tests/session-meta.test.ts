/** 会话元数据：标题 10–20 字、摘要 ≤120 字；超长让模型重压一次，失败走兜底，全程不硬截断 */
import { generateSessionMeta, newSession } from '../../utils/chat-store';
import { ChatMessage } from '../../utils/store';

const CFG = { provider: 'test', baseUrl: 'https://example.test', apiKey: 'k', model: 'm' } as any;

/** 模型的每次返回：标题一次、摘要一次（超长时再压一次） */
function mockModel(replies: Array<string | Error>) {
  let i = 0;
  (global as any).__wxStub.request = (opts: any) => {
    const next = replies[i++] || '';
    if (next instanceof Error) opts.fail({ errMsg: next.message });
    else opts.success({ statusCode: 200, data: { choices: [{ message: { content: next } }] } });
  };
}
function session(...texts: string[]): any {
  const messages: ChatMessage[] = texts.map((t, i) => ({
    id: `m${i}`, role: i % 2 ? 'ai' : 'user', kind: 'text', text: t, time: i,
  }));
  return { ...newSession(), messages };
}
const lines = (s: any) => s.messages.map((m: ChatMessage) => `${m.role === 'user' ? '用户' : '助手'}：${m.text}`);

test('生成标题与摘要：各问一次模型', async () => {
  mockModel(['给点点洗澡', '聊了给点点洗澡的过程，以及洗完怎么吹干才不感冒。']);
  const s = session('昨天给点点洗澡了', '好的，已整理', '洗完要吹干吗', '要的，吹干避免着凉');
  const meta = await generateSessionMeta(CFG, s, lines(s));
  expect(meta.title).toBe('给点点洗澡');
  expect(meta.summary).toBe('聊了给点点洗澡的过程，以及洗完怎么吹干才不感冒。');
  expect(meta.summary.length).toBeLessThanOrEqual(120);
});

test('摘要超长不硬截断：让模型重新压缩一次', async () => {
  mockModel(['洗澡那点事', '啊'.repeat(200), '聊了洗澡后吹干']);
  const s = session('昨天给点点洗澡了');
  const meta = await generateSessionMeta(CFG, s, lines(s));
  expect(meta.summary).toBe('聊了洗澡后吹干'); // 用重压后的结果，不是把长摘要截断
});

test('已有标题不重写，摘要照常刷新', async () => {
  mockModel(['新摘要']);
  const s = { ...session('昨天给点点洗澡了'), title: '洗澡那点事', summary: '旧摘要' };
  const meta = await generateSessionMeta(CFG, s, lines(s));
  expect(meta.title).toBe('洗澡那点事');
  expect(meta.summary).toBe('新摘要');
});

test('模型不可用 → 标题与摘要都用首句兜底，不抛错', async () => {
  mockModel([new Error('request:fail'), new Error('request:fail')]);
  const s = session('昨天给点点洗澡了，洗完自己躲进被子里', '好的');
  const meta = await generateSessionMeta(CFG, s, lines(s));
  expect(meta.title).toContain('洗澡');
  expect(meta.summary).toContain('洗澡');
  expect(meta.summary.length).toBeLessThanOrEqual(120);
});
