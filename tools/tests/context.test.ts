import { buildHistory, buildDraftStates, HISTORY_BUDGET } from '../../utils/context';
import { ChatMessage } from '../../utils/store';

const line = (i: number, text: string): ChatMessage => ({ id: String(i), role: i % 2 ? 'ai' : 'user', kind: 'text', text, time: Date.now() });

test('历史超过八轮仍保留，查询回复也进入上下文', () => {
  const messages = Array.from({ length: 30 }, (_, i) => line(i, `第${i}条`));
  messages[1].kind = 'query';
  expect(buildHistory(messages)).toHaveLength(30);
  expect(buildHistory(messages)[1].content).toBe('第1条');
});

test('预算只影响默认提示词，完整历史仍可按需取回', () => {
  const messages = Array.from({ length: 30 }, (_, i) => line(i, `${i}${'长'.repeat(1000)}`));
  expect(buildHistory(messages).length).toBeLessThan(30);
  expect(buildHistory(messages).reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(HISTORY_BUDGET);
  expect(buildHistory(messages, Infinity)).toHaveLength(30);
  expect(buildHistory(messages, Infinity, true)[0].referenceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('新话题隔离旧上下文，失败消息不成为助手知识', () => {
  const messages: ChatMessage[] = [line(0, '旧话题'), { ...line(1, ''), kind: 'divider' }, line(2, '新话题'), { ...line(3, '模型调用失败'), retry: true }];
  expect(buildHistory(messages).map((m) => m.content)).toEqual(['新话题']);
});

test('完整事实来源保留用户未整理的原文', () => {
  const messages = [{ ...line(0, '今天洗澡了'), sourceText: '  今天洗澡了！\n' }];
  expect(buildHistory(messages, Infinity, true)[0].content).toBe('  今天洗澡了！\n');
});

test('草稿实际字段仅来自当前话题与当前宠物，正文不能覆盖 date', () => {
  const card: ChatMessage = { id: 'card', role: 'ai', kind: 'draft', time: 1,
    draft: { key: 'card', petId: 'demo', date: '2026-10-16', text: '25年12月27号吃饭', tags: ['吃饭'], photos: [], status: 'pending' } };
  expect(buildDraftStates([card], 'demo')[0]).toMatchObject({ key: 'card', date: '2026-10-16', text: '25年12月27号吃饭', status: 'pending' });
  expect(buildDraftStates([card], 'other')).toEqual([]);
  expect(buildDraftStates([card, { id: 'divider', role: 'ai', kind: 'divider', time: 2 }], 'demo')).toEqual([]);
});
