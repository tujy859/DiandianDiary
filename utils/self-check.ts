/** 页面与自动化共用的核心自检。只传演示数据，不读写缓存、不请求网络。 */
import type { ChatMessage, DiaryRecord } from './store';
import { addDays, diffDays, parseDateWords, weekday } from './date';
import { validateDraft, validateDraftUpdate } from './draft';
import { queryRecordList } from './query';
import { buildHistory, currentSessionMessages, unclaimedPhotos } from './context';

export const SELF_CHECK_REFERENCE_DATE = '2026-10-15';
export interface SelfCheckResult { id: string; name: string; pass: boolean; detail: string }
export interface SelfCheck { id: string; name: string; run: () => string }
function verify(pass: boolean, detail: string): string {
  if (!pass) throw new Error(detail);
  return detail;
}
function rejects(work: () => unknown): boolean {
  try { work(); return false; } catch (_) { return true; }
}
function records(): DiaryRecord[] {
  const row = (id: string, date: string, text: string, petId = 'demo-pet'): DiaryRecord => ({
    id, date, text, petId, tags: [], photos: [], createdAt: 1, updatedAt: 1,
  });
  return [row('worm', '2026-10-01', '驱虫了'), row('other-pet', '2026-10-14', '驱虫了', 'other'),
    row('bath', '2026-10-12', '洗了澡'), row('vaccine', '2026-10-14', '打了疫苗'),
    row('old-worm', '2026-09-15', '驱虫了')];
}
const referenceDate = SELF_CHECK_REFERENCE_DATE;
export const CORE_SELF_CHECKS: readonly SelfCheck[] = [
  { id: 'date-year', name: '日期 · 两位 / 四位年份与星期', run: () => verify(
    ['25年10月1日', '2025年10月1日'].every(text => parseDateWords(text, referenceDate) === '2025-10-01')
      && weekday('2025-10-01') === '周三', '25年10月1日 → 2025-10-01 · 周三') },
  { id: 'date-uncertain', name: '日期 · 无效 / 不明确年份不猜当年', run: () => verify(
    ['25年2月29日', '99年10月1日', '上周左右洗澡'].every(text => parseDateWords(text, referenceDate) === null),
    '无效日历、不明确世纪和模糊日期均待用户确认') },
  { id: 'date-relative', name: '日期 · 相对年份、昨天与跨月天数', run: () => verify(
    parseDateWords('去年10月1日', referenceDate) === '2025-10-01'
      && parseDateWords('昨天洗澡', referenceDate) === '2026-10-14'
      && addDays('2026-10-01', -1) === '2026-09-30' && diffDays('2025-10-01', referenceDate) === 379,
    '按固定参考日期解释相对时间，跨年相差 379 天') },
  { id: 'draft-year', name: '草稿 · 摘句不能丢年份，原文完整保留', run: () => {
    const text = '25年10月1日，领养了小猫';
    const draft = validateDraft({ text: '领养了小猫', sourceText: '10月1日，领养了小猫', date: '2026-10-01' },
      { text, petId: 'demo-pet', photos: [] }, referenceDate);
    return verify(draft.date === '2025-10-01' && draft.rawInput.text === text, '模型错误年份被原文日期校正，原始输入保留');
  } },
  { id: 'draft-provenance', name: '草稿 · 编造出处或空正文不能出卡', run: () => verify(
    rejects(() => validateDraft({ text: '洗澡了', sourceText: '今天洗澡了' },
      { text: '今天没有洗澡', petId: 'demo-pet', photos: [] }, referenceDate))
      && rejects(() => validateDraft({ text: ' ' }, { text: '今天洗澡了', petId: 'demo-pet', photos: [] }, referenceDate)),
    '事实出处必须来自用户原话，正文不能为空') },
  { id: 'draft-date-context', name: '草稿 · 跨轮补年份，补记时间不覆盖事件日期', run: () => {
    const text = '12月27号，小猫在吃饭';
    const draft = validateDraft({ text: '小猫在吃饭', sourceText: text, dateSources: ['这是去年拍的'] },
      { text, petId: 'demo-pet', photos: [], userHistory: [{ content: '这是去年拍的', referenceDate }] }, referenceDate);
    return verify(draft.date === '2025-12-27' && draft.rawInput.text.includes('这是去年拍的'), '跨轮年份与月日组合为 2025-12-27，保留依据');
  } },
  { id: 'draft-correction', name: '草稿 · 日期更正仅修改待确认卡', run: () => {
    const state = { key: 'demo-card', petId: 'demo-pet', date: referenceDate, text: '小猫在吃饭', tags: ['吃饭'], status: 'pending' };
    const text = '日期应该是25年12月27号';
    const args = { key: state.key, sourceText: text, date: '2025-12-27' };
    const input = { text, petId: state.petId };
    const update = validateDraftUpdate(args, [state], input, referenceDate);
    return verify(update.patch.date === '2025-12-27' && state.date === referenceDate
      && rejects(() => validateDraftUpdate(args, [{ ...state, status: 'saved' }], input, referenceDate)),
    '先校验方案，不提前改卡；已保存卡拒绝聊天修改');
  } },
  { id: 'draft-future', name: '草稿 · 明确未来日期不能记为已发生', run: () => verify(
    rejects(() => validateDraft({ text: '洗澡了' },
      { text: '2027年1月1日洗澡', petId: 'demo-pet', photos: [] }, referenceDate)), '明确未来日期拒绝生成已发生草稿') },
  { id: 'query-event', name: '查询 · 驱虫不能串成较新的疫苗', run: () => {
    const result = queryRecordList({ petId: 'demo-pet', eventType: 'deworming', mode: 'latest', referenceDate }, records());
    return verify(result.latestDate === '2026-10-01' && result.daysElapsed === 14 && result.refs[0]?.recordId === 'worm',
      '驱虫命中 10月1日及对应原记录，不串疫苗');
  } },
  { id: 'query-isolation', name: '查询 · 宠物隔离与日期范围', run: () => {
    const result = queryRecordList({ petId: 'demo-pet', startDate: '2026-10-01', endDateExclusive: '2026-10-14', referenceDate }, records());
    return verify(result.totalMatched === 2 && result.records.every(row => ['bath', 'worm'].includes(row.id)),
      '只查目标宠物；包含起始日、不包含结束日');
  } },
  { id: 'query-page', name: '查询 · 排序、总数与分页', run: () => {
    const input = records(), before = JSON.stringify(input);
    const opts = { petId: 'demo-pet', mode: 'list' as const, limit: 1, referenceDate };
    const first = queryRecordList(opts, input), next = queryRecordList({ ...opts, offset: 1 }, input);
    return verify(first.totalMatched === 4 && first.records[0]?.id === 'vaccine' && first.nextOffset === 1
      && next.records[0]?.id === 'bath' && JSON.stringify(input) === before, '分页不改变总数，也不修改演示数据');
  } },
  { id: 'query-validation', name: '查询 · 非法参数明确拒绝', run: () => verify(
    rejects(() => queryRecordList({ petId: 'demo-pet', startDate: '2026-02-30' }, records()))
      && rejects(() => queryRecordList({ petId: 'demo-pet', limit: 0 }, records())), '无效日历与分页大小不能继续查询') },
  { id: 'context-boundary', name: '话题 · 旧内容与流程提示不进新上下文', run: () => {
    const messages: ChatMessage[] = [
      { id: 'old', role: 'user', kind: 'text', text: '旧话题', time: 1 },
      { id: 'boundary', role: 'ai', kind: 'divider', time: 2 },
      { id: 'new', role: 'user', kind: 'text', text: '新话题', time: 3 },
      { id: 'noise', role: 'ai', kind: 'text', text: '已整理为待确认草稿', time: 4 },
    ];
    const history = buildHistory(messages);
    return verify(currentSessionMessages(messages).length === 2 && history.length === 1 && history[0].content === '新话题',
      '仅当前话题自然消息进入模型上下文');
  } },
  { id: 'photo-claim', name: '照片 · 待确认认领、丢弃释放，跨话题隔离', run: () => {
    const user: ChatMessage = { id: 'photo', role: 'user', kind: 'text', text: '演示照片', photos: ['demo/photo.jpg'], time: 1 };
    const card: ChatMessage = { id: 'card', role: 'ai', kind: 'draft', time: 2,
      draft: { key: 'card', petId: 'demo-pet', date: null, text: '演示', tags: [], photos: ['demo/photo.jpg'], status: 'pending' } };
    const claimed = unclaimedPhotos([user, card]).length === 0;
    card.draft!.status = 'discarded';
    const released = unclaimedPhotos([user, card]).join() === 'demo/photo.jpg';
    return verify(claimed && released && unclaimedPhotos([user, { id: 'boundary', role: 'ai', kind: 'divider', time: 3 }]).length === 0,
      '演示照片不重复认领，丢弃后释放，旧话题照片不串入');
  } },
];

export function runCoreSelfChecks(checks: readonly SelfCheck[] = CORE_SELF_CHECKS): SelfCheckResult[] {
  return checks.map(check => {
    try { return { id: check.id, name: check.name, pass: true, detail: check.run() }; }
    catch (error: any) { return { id: check.id, name: check.name, pass: false, detail: error?.message || '检查异常' }; }
  });
}
