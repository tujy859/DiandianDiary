import { today, addDays, diffDays, parseDateWords, relDay, displayDate, weekday, isValidDate, parse } from '../../utils/date';

test.each([
  ['25年10月1日，领养了小猫', '2025-10-01'],
  ['帮我记一下25年1月1号测试咪出生了', '2025-01-01'],
  ['2025年10月1日领养了小猫', '2025-10-01'],
  ['25 年 10 月 1 日领养', '2025-10-01'],
  ['2025/10/1领养', '2025-10-01'],
  ['2025.10.1领养', '2025-10-01'],
  ['二零二五年10月1日领养', '2025-10-01'],
  ['二〇二五年10月1日领养', '2025-10-01'],
  ['去年10月1日领养', '2025-10-01'],
  ['前年的10月1日领养', '2024-10-01'],
  ['24年2月29日领养', '2024-02-29'],
])('完整保留年份：%s', (text, expected) => {
  expect(parseDateWords(text, '2026-10-15')).toBe(expected);
});

test.each(['25年2月29日领养', '25年13月1日领养', '5年10月1日领养', '025年10月1日领养',
  '12025年10月1日领养', '二十五年10月1日领养', '99年10月1日领养', '27年10月1日领养',
  '去年领养，早上很乖', '25年领养', '2025年1月1日和2026年1月1日出生'])('年份 / 日历不明确不能退回当年：%s', (text) => {
  expect(parseDateWords(text, '2026-10-15')).toBeNull();
});

test('真实日历校验：闰年、越界和非日期', () => {
  expect(isValidDate('2024-02-29')).toBe(true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-99-99', '2026-00-01', '2026-1-01', '', null]) expect(isValidDate(value)).toBe(false);
  expect(() => parse('2026-02-30')).toThrow();
  expect(parseDateWords('2024年2月29日洗澡', '2026-10-12')).toBe('2024-02-29');
  expect(parseDateWords('2026-02-30洗澡', '2026-10-12')).toBeNull();
  expect(parseDateWords('2月30日洗澡', '2026-10-12')).toBeNull();
  expect(parseDateWords('31号洗澡', '2026-04-12')).toBeNull();
});

describe('日期工具（确定性计算）', () => {
  test('今天 / 昨天 / 前天', () => {
    const t = today();
    expect(parseDateWords('今天给咪咪洗澡了')).toBe(t);
    expect(parseDateWords('昨天洗的澡')).toBe(addDays(t, -1));
    expect(parseDateWords('前天洗的澡')).toBe(addDays(t, -2));
    expect(parseDateWords('大前天洗的澡')).toBe(addDays(t, -3));
  });

  test('明确日期：X月X日', () => {
    expect(parseDateWords('10月5日洗的', '2026-10-12')).toBe('2026-10-05');
  });

  test('只说「几号」时接受当月已过去日期，晚于今天不猜上个月', () => {
    const t = '2026-10-12';
    const parsed = parseDateWords('3号打的疫苗', t);
    expect(parsed).not.toBeNull();
    expect(Number(parsed!.slice(8))).toBe(3);
    // 结果不应晚于今天
    expect(diffDays(t, parsed!)).toBeLessThanOrEqual(0);
    expect(parseDateWords('3号打的疫苗', '2026-10-02')).toBeNull();
    expect(parseDateWords('12月5日洗的澡', t)).toBeNull();
  });

  test('模糊时间绝不猜精确日期', () => {
    expect(parseDateWords('上周左右洗的澡')).toBeNull();
    expect(parseDateWords('大概前阵子')).toBeNull();
    expect(parseDateWords('最近')).toBeNull();
  });

  test('天数差与相对描述', () => {
    expect(diffDays(addDays(today(), -6), today())).toBe(6);
    expect(diffDays(today(), addDays(today(), -3))).toBe(-3);
    expect(relDay(today())).toBe('今天');
    expect(relDay(addDays(today(), -1))).toBe('昨天');
    expect(relDay(addDays(today(), -2))).toBe('前天');
    expect(relDay(addDays(today(), -5))).toBe('5天前');
  });

  test('展示格式', () => {
    const y = new Date().getFullYear();
    expect(displayDate(`${y}-10-12`)).toMatch(/^10月12日 · 周[一二三四五六日]$/);
    expect(displayDate(`${y - 1}-10-12`)).toMatch(new RegExp(`^${y - 1}年10月12日 · 周[一二三四五六日]$`));
    expect(weekday('2026-10-12')).toBe('周一');
    expect(displayDate('2026-99-99')).toBe('日期待修正');
    expect(relDay('2026-99-99')).toBe('');
  });
});
