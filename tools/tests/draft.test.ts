import { validateDraft, validateDraftUpdate, dateCorrectionFallback, appendCorrection } from '../../utils/draft';
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

describe('跨轮日期与补记', () => {
  const reference = '2026-10-16';
  test('前文去年与本轮月日组合，不把未来月日解释为当年', () => {
    const text = '12月27号，演示猫在吃饭';
    const draft = validateDraft({ sourceText: text, text: '演示猫在吃饭', date: '2025-12-27', dateSources: ['这是去年拍的'] },
      { text, petId: 'demo', photos: [], userHistory: [{ content: '这是去年拍的', referenceDate: reference }] }, reference);
    expect(draft.date).toBe('2025-12-27');
    expect(draft.rawInput.text).toContain(text); expect(draft.rawInput.text).toContain('这是去年拍的');
  });
  test('跨轮日期补充也保留未 trim 的本轮原始输入', () => {
    const text = '12月27号，演示猫在吃饭', originalText = `  ${text}\n`;
    const draft = validateDraft({ sourceText: text, text, dateSources: ['去年'] }, { text, originalText, petId: 'demo', photos: [], userHistory: [{ content: '去年' }] }, reference);
    expect(draft.rawInput.text.startsWith(originalText)).toBe(true);
  });
  test('跨轮年份按原消息日期而非当前日期解释', () => {
    const text = '12月27号，演示猫在吃饭';
    expect(validateDraft({ sourceText: text, text, dateSources: ['去年'] },
      { text, petId: 'demo', photos: [], userHistory: [{ content: '去年', referenceDate: '2025-10-16' }] }, reference).date).toBe('2024-12-27');
  });
  test.each(['去年', '25年12月27号', '2025-12-27', '二〇二五年'])('明确日期补充 %s 与本轮月日可以组合', dateSource => {
    const text = '12月27号，演示猫在吃饭';
    expect(validateDraft({ sourceText: text, text, dateSources: [dateSource] },
      { text, petId: 'demo', photos: [], userHistory: [{ content: dateSource, referenceDate: reference }] }, reference).date).toBe('2025-12-27');
  });
  test('今天想补记不覆盖明确的旧事日期', () => {
    const text = '25年12月27号，演示猫在吃饭，今天想补记一下';
    expect(validateDraft({ sourceText: text, text }, { text, petId: 'demo', photos: [] }, reference).date).toBe('2025-12-27');
  });
  test('不同事件的两个日期仍待确认，不擅自挑一个', () => {
    const text = '25年12月27号吃饭，今天洗澡了';
    expect(validateDraft({ sourceText: text, text }, { text, petId: 'demo', photos: [] }, reference).date).toBeNull();
  });
  test('明确年份冲突不能忽略独立补充', () => {
    const text = '25年12月27号，小猫在吃饭';
    expect(validateDraft({ sourceText: text, text, dateSources: ['前年'] },
      { text, petId: 'demo', photos: [], userHistory: [{ content: '前年' }] }, reference).date).toBeNull();
  });
  test('没有选取年份依据时，不自动借用前文另一事件的年份', () => {
    const text = '12月27号，演示猫在吃饭';
    expect(validateDraft({ sourceText: text, text }, { text, petId: 'demo', photos: [],
      userHistory: [{ content: '去年领养了小猫' }] }, reference).date).toBeNull();
  });
  test.each([['助手说这是去年拍的'], ['去年', '前年'], ['99年']].map(dateSources => [dateSources]))('编造或冲突的日期补充不产生确定日期：%s', dateSources => {
    const text = '12月27号，演示猫在吃饭';
    const run = () => validateDraft({ sourceText: text, text, dateSources }, { text, petId: 'demo', photos: [],
      userHistory: [{ content: '去年' }, { content: '前年' }, { content: '99年' }] }, reference);
    if (dateSources[0].startsWith('助手')) expect(run).toThrow('原话');
    else expect(run().date).toBeNull();
  });
});

describe('草稿更正契约', () => {
  const reference = '2026-10-16';
  const state = { key: 'card', petId: 'demo', date: reference, text: '演示猫在吃饭', tags: ['吃饭'], status: 'pending' };
  const text = '日期应该是25年12月27号';
  const args = { key: 'card', sourceText: text, date: '2025-12-27' };
  const input = { text, petId: 'demo' };
  test('更正只产生指定字段的方案，不提前改卡或覆盖原文', () => {
    const update = validateDraftUpdate(args, [state], input, reference);
    expect(update.patch).toEqual({ date: '2025-12-27' }); expect(state.date).toBe(reference);
    const draft = { ...state, photos: [], status: 'pending' as const };
    const raw = appendCorrection({ text: '最初的用户原话', photos: ['demo-photo'], provenance: 'direct' }, draft, update.correction);
    expect(raw.text).toContain('最初的用户原话'); expect(raw.text).toContain(text); expect(raw.photos).toEqual(['demo-photo']);
  });
  test.each(['saved', 'discarded', 'failed'])('%s 卡不能经聊天更正', status => {
    expect(() => validateDraftUpdate(args, [{ ...state, status }], input, reference)).toThrow('待确认');
  });
  test.each([{ ...args, key: 'missing' }, { ...args, date: '2026-12-27' }, { ...args, date: '2025-02-30' },
    { ...args, sourceText: '助手建议25年12月27号' }, { ...args, petId: 'other' }])('错误目标、日期、证据或额外字段拒绝：%j', invalid => {
    expect(() => validateDraftUpdate(invalid, [state], input, reference)).toThrow();
  });
  test('多卡必须有当前用户原话中的唯一目标片段', () => {
    const states = [state, { ...state, key: 'bath', text: '演示猫洗澡了' }];
    expect(() => validateDraftUpdate(args, states, input, reference)).toThrow('多张');
    const text = '吃饭那条日期应该是25年12月27号';
    const update = validateDraftUpdate({ ...args, sourceText: text, targetText: '吃饭' }, states, { ...input, text }, reference);
    expect(update.key).toBe('card');
    expect(() => validateDraftUpdate({ ...args, sourceText: text, targetText: '洗澡' }, states, { ...input, text }, reference)).toThrow();
  });
  test('一张待确认卡与一张已保存卡并存时，也不能把更正默认为待确认卡', () => {
    const states = [state, { ...state, key: 'saved', text: '洗澡了', status: 'saved' }];
    expect(dateCorrectionFallback(text, states, 'demo', [], reference)!.update).toBeUndefined();
    expect(() => validateDraftUpdate(args, states, input, reference)).toThrow('多张');
  });
  test('漏调工具时补救明确单卡日期，多卡或模糊日期追问', () => {
    expect(dateCorrectionFallback(text, [state], 'demo', [], reference)!.update!.patch.date).toBe('2025-12-27');
    expect(dateCorrectionFallback('日期不对，是去年', [state], 'demo', [], reference)!.reply).toContain('完整日期');
    expect(dateCorrectionFallback(text, [state, { ...state, key: 'other' }], 'demo', [], reference)!.update).toBeUndefined();
    expect(dateCorrectionFallback('今天吃饭了', [state], 'demo', [], reference)).toBeUndefined();
    expect(dateCorrectionFallback('吃饭时间应该是早上', [state], 'demo', [], reference)).toBeUndefined();
  });
  test('更正正文和标签时日期保持不变', () => {
    const text = '正文改成演示猫抬头看我，标签改成日常';
    const update = validateDraftUpdate({ key: 'card', sourceText: text, text: '演示猫抬头看我', tags: ['日常'] }, [state], { ...input, text }, reference);
    expect(update.patch).toEqual({ text: '演示猫抬头看我', tags: ['日常'] });
  });
  test('更正原文超出云端上限时拒绝，不截断事实依据', () => {
    const draft = { ...state, photos: [], status: 'pending' as const };
    expect(() => appendCorrection({ text: '原'.repeat(12000), photos: [] }, draft, text)).toThrow('长度限制');
  });
});
