/** 日期工具：所有查询/展示涉及的日期、天数都在这里做确定性计算 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Date -> 'YYYY-MM-DD'（本地时区） */
export function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parse(s: string): Date {
  if (!isValidDate(s)) throw new Error('日期无效，请使用真实的 YYYY-MM-DD 日期');
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1000 || y > 9999) return false;
  const value = new Date(y, m - 1, d);
  return value.getFullYear() === y && value.getMonth() === m - 1 && value.getDate() === d;
}

export function today(): string {
  return fmt(new Date());
}

export function addDays(s: string, n: number): string {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return fmt(d);
}

/** b - a 的天数差（b 比 a 晚几天） */
export function diffDays(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
}

export function weekday(s: string): string {
  if (!isValidDate(s)) return '星期未知';
  return WEEK[parse(s).getDay()];
}

/** '2026-10-05' -> '10月5日 · 周日'；跨年时补上年份：'2025年10月5日 · 周日' */
export function displayDate(s: string): string {
  if (!isValidDate(s)) return '日期待修正';
  const d = parse(s);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 · ${weekday(s)}`;
}

/** 相对今天：今天 / 昨天 / 前天 / n天前 / n天后 */
export function relDay(s: string): string {
  if (!isValidDate(s)) return '';
  const n = diffDays(s, today());
  if (n === 0) return '今天';
  if (n === 1) return '昨天';
  if (n === 2) return '前天';
  if (n > 0) return `${n}天前`;
  return `${-n}天后`;
}

/**
 * 从文本中解析明确的日期词。只接受确定日期：
 * 今天/昨天/前天/大前天、带年份日期、今年/去年/前年 + 月日、当年已过去的 X月X日。
 * 两位年份只展开为参考日期所在世纪、且不晚于参考年份的年份；其余需补四位年份。
 * 「上周左右」等模糊说法一律返回 null，交给用户确认，不猜精确日期。
 */
export function parseDateWords(text: string, referenceDate = today()): string | null {
  const t = referenceDate;
  if (!isValidDate(t)) return null;
  const referenceYear = parse(t).getFullYear();
  const digits = '零一二三四五六七八九';
  const normalizeYear = (value: string) => value.replace(/[零〇○一二三四五六七八九]/g,
    (char) => char === '〇' || char === '○' ? '0' : String(digits.indexOf(char)));
  const full = Array.from(text.matchAll(/(?:^|[^\d零〇○一二三四五六七八九])([\d零〇○一二三四五六七八九]+)\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?!\d)(?:[日号])?/g));
  if (full.length) {
    const dates: string[] = [];
    for (const match of full) {
      const rawYear = normalizeYear(match[1]);
      if (!/^\d{2}$|^\d{4}$/.test(rawYear)) return null;
      const year = rawYear.length === 2 ? Math.floor(referenceYear / 100) * 100 + Number(rawYear) : Number(rawYear);
      if (rawYear.length === 2 && year > referenceYear) return null;
      const value = `${year}-${pad(Number(match[2]))}-${pad(Number(match[3]))}`;
      if (!isValidDate(value)) return null;
      dates.push(value);
    }
    const unique = Array.from(new Set(dates));
    return unique.length === 1 ? unique[0] : null;
  }
  const relativeYear = text.match(/(今年|去年|前年|明年|后年)\s*的?\s*(\d{1,2})\s*月\s*(\d{1,2})(?!\d)\s*[日号]?/);
  if (relativeYear) {
    const offsets: Record<string, number> = { 今年: 0, 去年: -1, 前年: -2, 明年: 1, 后年: 2 };
    const value = `${referenceYear + offsets[relativeYear[1]]}-${pad(Number(relativeYear[2]))}-${pad(Number(relativeYear[3]))}`;
    return isValidDate(value) ? value : null;
  }
  // 已表达年份却不完整 / 不支持时，不能丢掉年份退回当年的月日或「早上」。
  if (hasYearExpression(text)) return null;
  if (/大前天/.test(text)) return addDays(t, -3);
  if (/前天/.test(text)) return addDays(t, -2);
  if (/昨天|昨晚/.test(text)) return addDays(t, -1);
  if (/今天|今早|今晚|刚刚|刚才|早上|中午|晚上/.test(text)) return t;
  const m = text.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})(?!\d)\s*[日号]?/);
  if (m) {
    const now = parse(t);
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d.getMonth() !== Number(m[1]) - 1 || d.getDate() !== Number(m[2])) return null;
    if (d.getTime() > now.getTime()) return null; // 不静默猜成去年
    return d.getMonth() === Number(m[1]) - 1 && d.getDate() === Number(m[2]) ? fmt(d) : null;
  }
  // 只说「几号」：接受当月已经过去的日期，未来日期的月份交给用户确认。
  const dm = text.match(/(?:^|[^\d])(\d{1,2})\s*[号日]/);
  if (dm) {
    const day = Number(dm[1]);
    if (day >= 1 && day <= 31) {
      const now = parse(t);
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      if (d.getMonth() !== now.getMonth()) return null;
      if (d.getTime() > now.getTime()) return null;
      return d.getDate() === day ? fmt(d) : null;
    }
  }
  return null;
}

/** 年份信息解析失败时必须保留不确定性，不能静默变成当年。 */
export function hasYearExpression(text: string): boolean {
  return /(?:\d+|[零〇○一二三四五六七八九十两]+)\s*年|今年|去年|前年|明年|后年/.test(text);
}
