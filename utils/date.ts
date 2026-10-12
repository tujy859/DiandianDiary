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
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
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
  return WEEK[parse(s).getDay()];
}

/** '2026-10-05' -> '10月5日 · 周日' */
export function displayDate(s: string): string {
  const d = parse(s);
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${weekday(s)}`;
}

/** 相对今天：今天 / 昨天 / 前天 / n天前 / n天后 */
export function relDay(s: string): string {
  const n = diffDays(s, today());
  if (n === 0) return '今天';
  if (n === 1) return '昨天';
  if (n === 2) return '前天';
  if (n > 0) return `${n}天前`;
  return `${-n}天后`;
}

/**
 * 从文本中解析明确的日期词。只接受确定日期：
 * 今天/昨天/前天/大前天、X月X日（按今年计，晚于今天则按去年）。
 * 「上周左右」等模糊说法一律返回 null，交给用户确认，不猜精确日期。
 */
export function parseDateWords(text: string): string | null {
  const t = today();
  if (/大前天/.test(text)) return addDays(t, -3);
  if (/前天/.test(text)) return addDays(t, -2);
  if (/昨天|昨晚/.test(text)) return addDays(t, -1);
  if (/今天|今早|今晚|刚刚|刚才|早上|中午|晚上/.test(text)) return t;
  const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    const now = new Date();
    let d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d.getTime() > now.getTime()) {
      d = new Date(now.getFullYear() - 1, Number(m[1]) - 1, Number(m[2]));
    }
    return fmt(d);
  }
  // 只说「几号」：默认当月；若晚于今天则按上个月计（例如 10月2日说「3号」指 9月3日）
  const dm = text.match(/(?:^|[^\d])(\d{1,2})\s*[号日]/);
  if (dm) {
    const day = Number(dm[1]);
    if (day >= 1 && day <= 31) {
      const now = new Date();
      let d = new Date(now.getFullYear(), now.getMonth(), day);
      if (d.getTime() > now.getTime()) {
        d = new Date(now.getFullYear(), now.getMonth() - 1, day);
      }
      return fmt(d);
    }
  }
  return null;
}
