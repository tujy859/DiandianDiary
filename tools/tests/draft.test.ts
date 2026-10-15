import { validateDraft } from '../../utils/draft';
import { extractJson } from '../../utils/llm';

test.each(['25年10月1日，领养了小猫', '10月1日，领养了小猫', '领养了小猫'])('原文日期不会因摘句缺失年份而变成当年：%s', (sourceText) => {
  const text = '25年10月1日，领养了小猫';
  const draft = validateDraft({ text: '领养了小猫', sourceText, date: '2026-10-01' },
    { text, petId: 'pet', photos: [] }, '2026-10-15');
  expect(draft.date).toBe('2025-10-01');
  expect(draft.rawInput.text).toBe(text);
});

test('JSON 降级也使用原文年份，不接受模型返回的当年日期', () => {
  const text = '25年10月1日，领养了小猫';
  const result = extractJson(JSON.stringify({ reply: '请确认草稿', query: null,
    draft: { text: '领养了小猫', sourceText: '10月1日，领养了小猫', date: '2026-10-01', tags: ['领养'] } }));
  expect(validateDraft(result.draft!, { text, petId: 'pet', photos: [] }, '2026-10-15').date).toBe('2025-10-01');
});

test('宠物名末尾的数字和「号」不能被补成日期', () => {
  const text = '给测试咪2号洗了澡';
  expect(validateDraft({ text, sourceText: '洗了澡' }, { text, petId: 'pet', photos: [] }, '2026-10-15').date).toBeNull();
});

test('年份不明确或无效日期不能因另一分句提到今天而被静默补齐', () => {
  const text = '99年10月1日领养，今天想记下来';
  expect(validateDraft({ text: '领养了小猫', sourceText: text }, { text, petId: 'pet', photos: [] }, '2026-10-15').date).toBeNull();
});

test('历史消息相对年份按原消息日期解释，明确未来日期仍拒绝', () => {
  const sourceText = '去年10月1日领养了小猫';
  const draft = validateDraft({ text: '领养了小猫', sourceText }, { text: '把刚才的记下来', petId: 'pet', photos: [],
    userHistory: [{ content: sourceText, referenceDate: '2025-10-15' }] }, '2026-10-15');
  expect(draft.date).toBe('2024-10-01');
  expect(() => validateDraft({ text: '领养了小猫', sourceText: '2027年1月1日领养' },
    { text: '2027年1月1日领养', petId: 'pet', photos: [] }, '2026-10-15')).toThrow('未来');
});

test('日记正文允许自然整理，只有事实出处要求引用原文', () => {
  const text = '昨晚和点点玩逗猫棒';
  const draft = validateDraft({ text: '晚上和点点玩了逗猫棒。', sourceText: text, tags: ['玩耍', '逗猫棒'] },
    { text, petId: 'pet', photos: [] }, '2026-10-14');
  expect(draft.text).toBe('晚上和点点玩了逗猫棒。');
  expect(draft.rawInput.text).toBe(text);
  expect(draft.date).toBe('2026-10-13');
});

test('整理后的正文不能冒充逐字引用的事实出处', () => {
  expect(() => validateDraft({ text: '晚上和点点玩了逗猫棒。', sourceText: '晚上和点点玩了逗猫棒。' },
    { text: '昨晚和点点玩逗猫棒', petId: 'pet', photos: [] }, '2026-10-14')).toThrow('原话');
});
