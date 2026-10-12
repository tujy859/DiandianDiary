import { queryRecords, resolveQueryOptions, timeRangeFromText } from '../../utils/query';
import { addRecord, savePet, updateRecord, removeRecord, Pet } from '../../utils/store';
import { respond } from '../../utils/intent';

let pet: Pet;
const add = (date: string, text: string, tags = ['医疗'], petId = pet.id) => addRecord({ date, text, tags, petId, photos: [] });
beforeEach(() => {
  (global as any).__wxStub.clearStorageSync();
  jest.useFakeTimers().setSystemTime(new Date('2026-10-12T12:00:00+08:00'));
  pet = savePet({ name: '咪咪', species: '猫' });
});
afterEach(() => jest.useRealTimers());

test('驱虫不能命中较新的疫苗，也不能从宽泛医疗标签推断', () => {
  const worm = add('2026-10-01', '做了驱虫');
  add('2026-10-11', '打了疫苗');
  add('2026-10-12', '喂了海乐妙，未注明用途');
  const result = queryRecords({ petId: pet.id, eventType: 'deworming' });
  expect(result.totalMatched).toBe(1);
  expect(result.records[0].id).toBe(worm.id);
  expect(result.daysElapsed).toBe(11);
  expect(respond({ text: '上次什么时候驱虫', petId: pet.id, petName: pet.name, photos: [] })[0].refs![0].recordId).toBe(worm.id);
});
test('没有做的事件、计划和问句不会当成已完成事件匹配', () => {
  add('2026-10-10', '今天没驱虫');
  add('2026-10-11', '明天驱虫');
  add('2026-10-12', '今天该不该驱虫？');
  expect(queryRecords({ petId: pet.id, eventType: 'deworming' }).totalMatched).toBe(0);
});
test('只筛选当前宠物；统计在 limit 之前；结束日期不包含', () => {
  add('2026-09-30', '驱虫');
  add('2026-10-01', '驱虫');
  add('2026-10-12', '驱虫');
  add('2026-11-01', '驱虫');
  add('2026-10-11', '驱虫', ['医疗'], 'other');
  const result = queryRecords({ petId: pet.id, eventType: 'deworming', startDate: '2026-10-01', endDateExclusive: '2026-11-01', limit: 1 });
  expect(result.totalMatched).toBe(2);
  expect(result.records).toHaveLength(1);
});
test('罐头不能扩大到所有喂食；具体清洁项目也保留关键词', () => {
  add('2026-10-01', '吃了罐头', ['喂食']);
  add('2026-10-12', '吃了猫粮', ['喂食']);
  const result = queryRecords({ ...resolveQueryOptions('这个月吃了几次罐头'), petId: pet.id });
  expect(result.totalMatched).toBe(1);
  expect(result.summary).toContain('一条日记可能包含多次事件');
  expect(resolveQueryOptions('上次什么时候刷牙').keyword).toBe('刷牙');
});
test('本地月查询真正过滤月份，并随修改、删除重新读取', () => {
  const old = add('2026-09-30', '洗澡', ['洗澡']);
  const current = add('2026-10-01', '洗澡', ['洗澡']);
  const query = () => respond({ text: '这个月洗了几次澡', petId: pet.id, petName: pet.name, photos: [] })[0];
  expect(query().text).toContain('共 1 条');
  updateRecord(old.id, { date: '2026-10-02' });
  expect(query().text).toContain('共 2 条');
  removeRecord(current.id);
  expect(query().text).toContain('共 1 条');
});
test('用户明确事件和月份覆盖模型的错误解析', () => {
  const opts = resolveQueryOptions('这个月驱虫几次', { eventType: 'vaccination', keyword: '疫苗', startDate: '2020-01-01', mode: 'latest' });
  expect(opts.eventType).toBe('deworming');
  expect(opts.keyword).toBeUndefined();
  expect(opts.startDate).toBe('2026-10-01');
  expect(opts.mode).toBe('count');
});
test('事实与问题分开：今天的事实不限制上次查询为今天', () => {
  expect(resolveQueryOptions('今天给咪咪洗澡了，上次什么时候洗澡？').startDate).toBeUndefined();
  expect(resolveQueryOptions('这个月，洗澡几次？').startDate).toBe('2026-10-01');
});
test.each([
  ['这个月', '2026-10-01', '2026-11-01'],
  ['上个月', '2026-09-01', '2026-10-01'],
  ['上周', '2026-10-05', '2026-10-12'],
  ['本周', '2026-10-12', '2026-10-19'],
  ['最近7天', '2026-10-06', '2026-10-13'],
  ['2024年2月', '2024-02-01', '2024-03-01'],
  ['2026-09-30 到 2026-10-01', '2026-09-30', '2026-10-02'],
  ['10月1日到10月12日', '2026-10-01', '2026-10-13'],
  ['2025年12月30日到2026年1月2日', '2025-12-30', '2026-01-03'],
])('范围解析 %s', (text, startDate, endDateExclusive) => {
  expect(timeRangeFromText(text, '2026-10-12')).toEqual({ startDate, endDateExclusive });
});
test('一月的上个月跨年，周边界跨年，最近天数包含今天', () => {
  expect(timeRangeFromText('上个月', '2026-01-12')).toEqual({ startDate: '2025-12-01', endDateExclusive: '2026-01-01' });
  expect(timeRangeFromText('上周', '2026-01-01')).toEqual({ startDate: '2025-12-22', endDateExclusive: '2025-12-29' });
  expect(timeRangeFromText('最近1天', '2026-01-01')).toEqual({ startDate: '2026-01-01', endDateExclusive: '2026-01-02' });
});
test.each(['上周左右', '最近0天', '2026年13月', '2026-02-30到2026-03-01', '2026-2-30', '过去3个月', '最近一个月', '12月30日到1月2日', '去年'])('不支持或有歧义的范围 %s 必须追问', (text) => {
  expect(() => timeRangeFromText(text, '2026-10-12')).toThrow();
});
test.each([{ limit: 0 }, { limit: -1 }, { limit: 100 }, { limit: 1.5 }, { limit: '3' }, { startDate: '2026-02-30' }, { startDate: '2026-10-12', endDateExclusive: '2026-10-01' }, { eventType: 'medical' }])('拒绝非法接口参数 %j', (args) => {
  expect(() => queryRecords({ petId: pet.id, ...args } as any)).toThrow();
});
test('旧库中非法日期不参与查询', () => {
  (global as any).__wxStub.setStorageSync('jd_records', [{ id: 'bad', petId: pet.id, date: '2026-99-99', text: '驱虫', tags: ['医疗'] }]);
  expect(queryRecords({ petId: pet.id, eventType: 'deworming' }).totalMatched).toBe(0);
});
