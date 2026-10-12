import { today, addDays, diffDays, parseDateWords, relDay, displayDate, weekday } from '../../utils/date';

describe('日期工具（确定性计算）', () => {
  test('今天 / 昨天 / 前天', () => {
    const t = today();
    expect(parseDateWords('今天给咪咪洗澡了')).toBe(t);
    expect(parseDateWords('昨天洗的澡')).toBe(addDays(t, -1));
    expect(parseDateWords('前天洗的澡')).toBe(addDays(t, -2));
    expect(parseDateWords('大前天洗的澡')).toBe(addDays(t, -3));
  });

  test('明确日期：X月X日', () => {
    expect(parseDateWords('10月5日洗的')).toMatch(/^\d{4}-10-05$/);
  });

  test('只说「几号」时按当月（晚于今天则算上个月）', () => {
    const t = today();
    const parsed = parseDateWords('3号打的疫苗');
    expect(parsed).not.toBeNull();
    expect(Number(parsed!.slice(8))).toBe(3);
    // 结果不应晚于今天
    expect(diffDays(t, parsed!)).toBeLessThanOrEqual(0);
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
    expect(displayDate('2026-10-12')).toMatch(/^10月12日 · 周[一二三四五六日]$/);
    expect(weekday('2026-10-12')).toBe('周一');
  });
});
