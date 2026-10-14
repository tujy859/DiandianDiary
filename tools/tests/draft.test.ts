import { validateDraft } from '../../utils/draft';

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
