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
 * 今天/昨天/前天/大前天、带年份日期、当年已经过去的 X月X日。
 * 「上周左右」等模糊说法一律返回 null，交给用户确认，不猜精确日期。
 */
export function parseDateWords(text: string, referenceDate = today()): string | null {
  const t = referenceDate;
  const full = text.match(/(\d{4})\s*[-年]\s*(\d{1,2})\s*[-月]\s*(\d{1,2})(?:[日号])?/);
  if (full) {
    const value = `${full[1]}-${pad(Number(full[2]))}-${pad(Number(full[3]))}`;
    return isValidDate(value) ? value : null;
  }
  if (/大前天/.test(text)) return addDays(t, -3);
  if (/前天/.test(text)) return addDays(t, -2);
  if (/昨天|昨晚/.test(text)) return addDays(t, -1);
  if (/今天|今早|今晚|刚刚|刚才|早上|中午|晚上/.test(text)) return t;
  const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
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
