import { beginTrace, getDebugTraces, debugReport, setTraceEnabled, MAX_TRACES, MAX_TRACE_EVENTS } from '../../utils/debug-trace';
import { enableDeveloperMode, disableDeveloperMode } from '../../utils/developer';
import { setCloudSession } from '../../utils/store';
import { logoutLocal } from '../../utils/family-state';

beforeEach(() => { wx.clearStorageSync(); setCloudSession({ userId: 'demo-user', familyId: 'demo-family' }); });
afterEach(() => jest.restoreAllMocks());
test('默认不记录；开发者模式与显式开关同时开启才记录', () => {
  expect(beginTrace()).toBeUndefined();
  enableDeveloperMode(); expect(beginTrace()).toBeUndefined();
  setTraceEnabled(true); expect(beginTrace()).toBeDefined();
  disableDeveloperMode(); expect(beginTrace()).toBeUndefined();
});
test('日志只保留允许字段，任意正文、Key、照片和错误回显不会出现在报告', () => {
  enableDeveloperMode(); setTraceEnabled(true);
  const trace = beginTrace()!;
  trace.emit('tool.result', { keyword: '私人全文和sk-secret', error: 'Bearer sk-secret private photo',
    records: [{ id: 'record-1', date: '2025-01-01', text: '私人日记' }], apiKey: 'sk-secret', sourceText: '私人日记', photos: ['private.jpg'], matched: 1 } as any);
  trace.finish('complete', { refs: ['record-1'] });
  const report = debugReport();
  for (const value of ['sk-secret', '私人', 'private', 'apiKey', 'sourceText', 'photos']) expect(report).not.toContain(value);
  expect(report).toContain('record-1'); expect(report).toContain('2025-01-01');
});
test('请求与事件都限量，日志按家庭隔离；关闭模式后停止旧句柄写入', () => {
  enableDeveloperMode(); setTraceEnabled(true);
  for (let i = 0; i < MAX_TRACES + 3; i++) beginTrace();
  expect(getDebugTraces()).toHaveLength(MAX_TRACES);
  const trace = beginTrace()!;
  for (let i = 0; i < MAX_TRACE_EVENTS + 3; i++) trace.emit('tool.start', { round: i });
  expect(getDebugTraces().find(r => r.id === trace.id)!.events).toHaveLength(MAX_TRACE_EVENTS);
  setCloudSession({ userId: 'demo-user', familyId: 'other' });
  trace.emit('late.event', {}); expect(getDebugTraces()).toEqual([]);
  beginTrace(); disableDeveloperMode(); trace.finish('complete');
  expect(getDebugTraces()).toEqual([]);
});
test('退出再登录同账号家庭，迟到日志不会恢复缓存', () => {
  enableDeveloperMode(); setTraceEnabled(true); const trace = beginTrace()!;
  logoutLocal(); setCloudSession({ userId: 'demo-user', familyId: 'demo-family' });
  trace.finish('complete'); expect(getDebugTraces()).toEqual([]);
});
test('存储额度失败不影响业务；日志观察器抛错也不影响 agent', () => {
  enableDeveloperMode(); setTraceEnabled(true);
  jest.spyOn(wx, 'setStorageSync').mockImplementation(() => { throw new Error('quota'); });
  expect(beginTrace()).toBeUndefined();
});
