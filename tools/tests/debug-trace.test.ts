import { beginTrace, getDebugTraces, debugReport, setTraceEnabled, MAX_TRACES, MAX_TRACE_EVENTS, photoUploadHost } from '../../utils/debug-trace';
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

test('草稿更正日志保留工具与日期，不采集更正原话、目标正文或补充证据', () => {
  enableDeveloperMode(); setTraceEnabled(true);
  const trace = beginTrace()!;
  trace.emit('draft.update_applied', { tool: 'update_draft_record', date: '2025-12-27', status: 'pending',
    correction: 'private correction', targetText: 'private draft', dateSources: ['private year'] } as any);
  const detail = getDebugTraces()[0].events.find(event => event.phase === 'draft.update_applied')!.detail;
  expect(detail).toEqual({ tool: 'update_draft_record', date: '2025-12-27', status: 'pending' });
  expect(debugReport()).not.toContain('private');
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

test('照片诊断只保留字节数和失败步骤，超限单独分类且不泄漏文件与凭证', () => {
  enableDeveloperMode(); setTraceEnabled(true);
  const trace = beginTrace()!;
  trace.emit('photo.read', { photoIndex: 0, sourceBytes: 819200, uploadBytes: 819200, filePath: 'private/photo.png', headers: { token: 'private-token' } } as any);
  trace.emit('photo.failure', { path: 'upload', error: 'file size exceeded private-token' });
  trace.emit('photo.failure', { path: 'complete', error: '请选择支持的照片格式（JPG、PNG）' });
  trace.emit('photo.read', { photoIndex: -1, sourceBytes: Infinity, uploadBytes: 'private-token' } as any);
  const events = getDebugTraces()[0].events.filter(event => event.phase.startsWith('photo.'));
  expect(events[0].detail).toEqual({ photoIndex: 0, sourceBytes: 819200, uploadBytes: 819200 });
  expect(events[1].detail).toEqual({ path: 'upload', error: '照片大小超限' });
  expect(events[2].detail).toEqual({ path: 'complete', error: '照片格式不支持' });
  expect(events[3].detail).toEqual({});
  expect(debugReport()).not.toContain('private');
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

test('上传诊断只提取主机名，清洗时拒绝完整地址、端口、账号及授权回显', () => {
  const url = 'https://UPLOAD.EXAMPLE/pending/private-photo.jpg?token=private-token#private-signature';
  expect(photoUploadHost(url)).toBe('upload.example');
  for (const invalid of ['http://upload.example/path', 'https://user:password@upload.example/path',
    'https://upload.example:443/path', 'https://bad..example/path', 'https://bad_host.example/path']) {
    expect(photoUploadHost(invalid)).toBeUndefined();
  }
  enableDeveloperMode(); setTraceEnabled(true);
  const trace = beginTrace()!;
  trace.emit('photo.upload', { uploadHost: photoUploadHost(url), url, headers: { authorization: 'private-token' } } as any);
  trace.emit('photo.failure', { uploadHost: url });
  expect(getDebugTraces()[0].events[1].detail).toEqual({ uploadHost: 'upload.example' });
  expect(getDebugTraces()[0].events[2].detail).toEqual({});
  expect(debugReport()).toContain('upload.example');
  expect(debugReport()).not.toMatch(/https:|private|authorization|token|pending/);
});
