import { DiaryRecord, getRecords, RefInfo } from './store';
import { addDays, diffDays, fmt, isValidDate, parse, today } from './date';

/** 展示标签可以宽泛，事实检索必须区分具体事件。旧记录按原文/具体标签匹配，不把「医疗」推断成驱虫。 */
const EVENTS = {
  bath: { label: '洗澡', words: ['洗澡', '洗了澡', '洗过澡', '洗的澡', '洗护'] },
  deworming: { label: '驱虫', words: ['驱虫'] },
  vaccination: { label: '疫苗', words: ['疫苗', '接种'] },
  vet_visit: { label: '就医', words: ['就医', '看病', '看医生', '医院', '体检'] },
  feeding: { label: '喂食', words: ['喂食', '喂了', '吃了', '罐头', '猫粮', '狗粮', '冻干', '零食', '加餐', '吃饭'] },
  cleaning: { label: '清洁', words: ['清洁', '剪指甲', '梳毛', '刷牙', '洗耳朵', '剃毛'] },
  play: { label: '玩耍', words: ['玩耍', '逗猫', '玩了'] },
  outing: { label: '外出', words: ['外出', '散步', '出门', '遛'] },
  elimination: { label: '排泄', words: ['排泄', '便便', '尿了', '拉屎', '猫砂'] },
  sleep: { label: '睡眠', words: ['睡眠', '睡着了', '睡觉'] },
};
export type EventType = keyof typeof EVENTS;
export const EVENT_TYPES = Object.keys(EVENTS) as EventType[];
export interface RecordQueryOptions {
  petId: string; // 只能由执行器注入
  eventType?: EventType;
  keyword?: string;
  startDate?: string;
  endDateExclusive?: string;
  mode?: 'latest' | 'count' | 'list';
  limit?: number;
  offset?: number;
  referenceDate?: string; // 请求时的本地日期，方便固定相对时间和测试
}
export interface RecordQueryResult {
  summary: string;
  totalMatched: number;
  latestDate: string | null;
  daysElapsed: number | null;
  records: Array<Pick<DiaryRecord, 'id' | 'date' | 'text' | 'tags'>>;
  refs: RefInfo[];
  nextOffset: number | null;
}

export function queryPart(text: string): string {
  const parts = text.split(/[，,。；;！？!?\n]/).filter(Boolean);
  const question = parts.filter((p) => /上次|最近|什么时候|啥时候|多久|多少天|几次|多少次|记录|日记/.test(p)).pop() || text;
  const rangePrefix = parts.find((p) => p !== question && !inferEvent(p)
    && /这个月|本月|上个月|上月|本周|这周|上周|最近\d+天|\d{4}年\d+月/.test(p));
  return rangePrefix ? rangePrefix + '，' + question : question;
}

export function isHistoryQuery(text: string): boolean {
  return /上次|什么时候|啥时候|多久|多少天|几次|多少次|多少条|列出|查查|查一下|查询|查下|(?:查|看).*(?:记录|日记)|(?:最近|本月|这个月|上个月|上周|这周).*(?:记录|日记)/.test(text);
}

export function inferEvent(text: string): EventType | undefined {
  const cleaned = text.replace(/几次|多少次|什么时候|上次|了|过|的/g, '');
  return EVENT_TYPES.find((key) => EVENTS[key].words.some((word) => cleaned.includes(word)));
}

/** 自然语言的日历范围。人类的结束日包含在内，内部统一为左闭右开。周从周一开始。 */
export function timeRangeFromText(text: string, referenceDate = today()): Partial<RecordQueryOptions> {
  const now = parse(referenceDate);
  const tomorrow = addDays(referenceDate, 1);
  const month = (offset: number) => fmt(new Date(now.getFullYear(), now.getMonth() + offset, 1));
  const week = addDays(referenceDate, -((now.getDay() + 6) % 7));
  if (/左右|大概|大约|前阵子|前段时间|近期|前不久/.test(text)) throw new Error('时间范围不明确，请提供起止日期，或说「这个月」「上周」「最近7天」。');
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g);
  if (dates && dates.length) {
    if (dates.length > 2 || dates.some((d) => !isValidDate(d))) throw new Error('查询日期无效');
    if (dates.length === 2 && !/至|到|~|～|—/.test(text)) throw new Error('请明确两个日期之间的起止关系');
    return { startDate: dates[0], endDateExclusive: addDays(dates[dates.length - 1], 1) };
  }
  if (/\d{4}-\d/.test(text)) throw new Error('查询日期请使用有效的 YYYY-MM-DD');
  const calendarDays = Array.from(text.matchAll(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g));
  if (calendarDays.length) {
    if (calendarDays.length > 2) throw new Error('请只指定一个起止日期范围');
    const year = calendarDays[0][1] || String(now.getFullYear());
    const values = calendarDays.map((match) => `${match[1] || year}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`);
    if (values.some((value) => !isValidDate(value))) throw new Error('查询日期无效');
    if (values.length === 2 && !/至|到|~|～|—/.test(text)) throw new Error('请明确两个日期之间的起止关系');
    if (values[0] > values[values.length - 1]) throw new Error('起止日期顺序或年份不明确，请补充年份');
    return { startDate: values[0], endDateExclusive: addDays(values[values.length - 1], 1) };
  }
  if (/上个月|上月/.test(text)) return { startDate: month(-1), endDateExclusive: month(0) };
  if (/这个月|本月|这月/.test(text)) return { startDate: month(0), endDateExclusive: month(1) };
  if (/上周|上星期/.test(text)) return { startDate: addDays(week, -7), endDateExclusive: week };
  if (/本周|这周|这星期/.test(text)) return { startDate: week, endDateExclusive: addDays(week, 7) };
  const recent = text.match(/(?:最近|近|过去)\s*(\d+)\s*天/);
  if (recent) {
    const n = Number(recent[1]);
    if (n < 1 || n > 3660) throw new Error('最近天数需在 1 到 3660 之间');
    return { startDate: addDays(referenceDate, 1 - n), endDateExclusive: tomorrow };
  }
  const ym = text.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/);
  if (ym) {
    if (/月\s*\d/.test(text)) throw new Error('请使用 YYYY-MM-DD 至 YYYY-MM-DD 指定日范围');
    // 只说月份且还未到该月时，年份有歧义，交给用户明确。
    if (!ym[1] && Number(ym[2]) > now.getMonth() + 1) throw new Error('请补充查询月份的年份');
    const year = Number(ym[1] || now.getFullYear());
    const m = Number(ym[2]);
    const startDate = `${year}-${String(m).padStart(2, '0')}-01`;
    if (!isValidDate(startDate)) throw new Error('查询月份无效');
    return { startDate, endDateExclusive: fmt(new Date(year, m, 1)) };
  }
  if (/昨天/.test(text)) return { startDate: addDays(referenceDate, -1), endDateExclusive: referenceDate };
  if (/今天/.test(text)) return { startDate: referenceDate, endDateExclusive: tomorrow };
  if (/去年|今年|前天|下个月|下月|下周|下星期|明年|明天|后天|(?:\d+|[一二三四五六七八九十两]+)\s*(?:个?月|年|周|星期)|(?:过去|最近|近).*(?:天|月|周|年)|从|截至|之前|之后|以来|到/.test(text)) {
    throw new Error('暂不支持这个时间表达，请提供 YYYY-MM-DD 至 YYYY-MM-DD，或使用「这个月」「上周」「最近7天」。');
  }
  return {};
}

/** 可确定的用户原话优先于模型参数，避免模型忽略月份或换错事件。 */
export function resolveQueryOptions(text: string, args: Record<string, any> = {}, referenceDate = today()): Omit<RecordQueryOptions, 'petId'> {
  const part = queryPart(text);
  const eventType = inferEvent(part);
  const specific = part.match(/罐头|猫粮|狗粮|冻干|零食|剪指甲|梳毛|刷牙|洗耳朵|剃毛|体检|体重|呕吐|拉稀|绝育|吃药|精神|食欲|医疗/);
  // 「今天该不该洗澡」中的今天是决策日期，不是要求只查今天的洗澡记录。
  const consult = !isHistoryQuery(text) && /该不该|要不要|吗|怎么办|如何|建议/.test(part);
  const range = consult ? {} : timeRangeFromText(part, referenceDate);
  return {
    eventType: eventType || args.eventType,
    keyword: specific ? specific[0] : eventType ? undefined : args.keyword,
    startDate: args.startDate,
    endDateExclusive: args.endDateExclusive,
    mode: /几次|多少次|第几次|多少条/.test(part) ? 'count' : /上次|什么时候|多久|多少天/.test(part) ? 'latest' : args.mode || 'list',
    limit: args.limit,
    referenceDate,
    ...range,
  };
}

function matches(record: DiaryRecord, opts: RecordQueryOptions): boolean {
  const clauses = (record.text || '').split(/[，,。；;！？!?\n]/)
    .filter((p) => !/没(?:有)?|未|不曾|不打算|明天|后天|下周|打算|准备|计划|想给|该不该|要不要|吗/.test(p));
  if (opts.eventType) {
    const event = EVENTS[opts.eventType];
    const concreteTag = record.tags.includes(event.label);
    const mentioned = event.words.some((word) => (record.text || '').includes(word));
    if (!clauses.some((p) => event.words.some((word) => p.includes(word))) && !(concreteTag && !mentioned)) return false;
  }
  if (opts.keyword && !clauses.some((p) => p.includes(opts.keyword!)) && !record.tags.includes(opts.keyword)) return false;
  return true;
}

export function queryRecords(opts: RecordQueryOptions): RecordQueryResult {
  return queryRecordList(opts, getRecords(opts.petId));
}

/** 同一查询核心可在独立内存数据上运行；不读写 Storage，也不修改传入记录。 */
export function queryRecordList(opts: RecordQueryOptions, input: readonly DiaryRecord[]): RecordQueryResult {
  if (!opts.petId) throw new Error('查询缺少宠物');
  if (opts.eventType !== undefined && !EVENT_TYPES.includes(opts.eventType)) throw new Error('未知事件类型');
  if (opts.keyword !== undefined && (typeof opts.keyword !== 'string' || opts.keyword.length > 100)) throw new Error('查询关键词无效');
  if (opts.mode !== undefined && !['latest', 'count', 'list'].includes(opts.mode)) throw new Error('未知查询模式');
  for (const date of [opts.startDate, opts.endDateExclusive, opts.referenceDate]) {
    if (date !== undefined && !isValidDate(date)) throw new Error('查询日期无效');
  }
  if (opts.startDate && opts.endDateExclusive && opts.startDate >= opts.endDateExclusive) throw new Error('查询结束日期必须晚于开始日期');
  const limit = opts.limit === undefined ? 3 : opts.limit;
  const offset = opts.offset === undefined ? 0 : opts.offset;
  if (!Number.isInteger(offset) || offset < 0) throw new Error('分页偏移需为非负整数');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('返回条数需为 1 到 50 的整数');
  const matched = input.filter((r) => r.petId === opts.petId && isValidDate(r.date)
    && (!opts.startDate || r.date >= opts.startDate)
    && (!opts.endDateExclusive || r.date < opts.endDateExclusive) && matches(r, opts))
    .sort((a, b) => a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1);
  const reference = opts.referenceDate || today();
  const pageSize = opts.mode === 'latest' ? 1 : limit;
  const records = matched.slice(offset, offset + pageSize).map(({ id, date, text, tags }) => ({ id, date, text, tags }));
  const latest = matched[0];
  const daysElapsed = latest ? diffDays(latest.date, reference) : null;
  const scope = opts.startDate || opts.endDateExclusive
    ? `${opts.startDate || '最早'} 至 ${opts.endDateExclusive ? addDays(opts.endDateExclusive, -1) : '至今'}范围内` : '时光册里';
  const label = opts.keyword || (opts.eventType ? EVENTS[opts.eventType].label : '全部');
  const when = daysElapsed === 0 ? '今天' : daysElapsed! > 0 ? `${daysElapsed}天前` : `${-daysElapsed!}天后`;
  let summary = latest
    ? `${scope}共 ${matched.length} 条「${label}」记录。最近一条是 ${latest.date}（${when}）。\n当时记的是：${latest.text || '（照片日记）'}`
    : `${scope}没有找到「${label}」记录。`;
  if (opts.mode === 'list' && records.length > 1) summary += '\n' + records.map((r) => `${r.date} ${r.text || '（照片日记）'}`).join('\n');
  if (offset > 0 && opts.mode !== 'count') summary = `${scope}共 ${matched.length} 条「${label}」记录。本页从第 ${offset + 1} 条起，共 ${records.length} 条。\n`
    + records.map((r) => `${r.date} ${r.text || '（照片日记）'}`).join('\n');
  if (opts.mode === 'count') summary += '\n按已保存的日记条数统计，一条日记可能包含多次事件。';
  return {
    summary, totalMatched: matched.length, latestDate: latest ? latest.date : null, daysElapsed, records,
    nextOffset: offset + pageSize < matched.length ? offset + pageSize : null,
    refs: records.map((r) => ({ recordId: r.id, label: '查看原记录', sub: `${r.date} ${r.text.slice(0, 30) || '（照片日记）'}` })),
  };
}
