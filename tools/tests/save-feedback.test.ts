import { photoUploadError, photoStageError } from '../../utils/photo-upload-error';
import { diarySaveFeedback } from '../../utils/save-feedback';
import { traceError, beginTrace, debugReport, setTraceEnabled } from '../../utils/debug-trace';
import { enableDeveloperMode } from '../../utils/developer';
import { setCloudSession } from '../../utils/store';
import { updateRecord } from '../../utils/repository';
import { saveProgressView } from '../../utils/save-progress';
import Dialog from 'tdesign-miniprogram/dialog/index';

jest.mock('../../utils/repository', () => ({ updateRecord: jest.fn() }));
jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: { alert: jest.fn() } }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });

test.each([
  ['request:fail url not in domain list https://upload.example/private?token=demo', undefined, 'PHOTO_DOMAIN'],
  ['request:fail timeout https://upload.example/private?token=demo', undefined, 'PHOTO_TIMEOUT'],
  ['request:fail SSL certificate error', undefined, 'PHOTO_TLS'],
  ['request:fail connection reset', undefined, 'PHOTO_NETWORK'],
  ['private body', 403, 'PHOTO_AUTH'], ['private body', 413, 'PHOTO_CAPACITY'],
  ['private body', 500, 'PHOTO_SERVICE'], ['private body', 504, 'PHOTO_TIMEOUT'],
  ['private body', 400, 'PHOTO_UPLOAD'],
])('上传错误 %s / %s 分类为 %s，并丢弃原文和授权地址', (errMsg, status: number | undefined, code) => {
  const error = photoUploadError({ errMsg }, status);
  expect(error.code).toBe(code); expect(error.statusCode).toBe(status);
  expect(JSON.stringify(error)).not.toMatch(/private|token|upload\.example/);
  expect(diarySaveFeedback(error, 'upload').message).not.toMatch(/private|token|upload\.example/);
});

test('照片确认错误与日记写入错误分开，已写入日记不能提示确定未保存', () => {
  const format = photoStageError({ code: 'INVALID', message: '请选择支持的照片格式（JPG）' }, 'complete');
  expect(format.code).toBe('PHOTO_FORMAT');
  expect(diarySaveFeedback(format, 'confirm').message).toContain('格式');
  expect(photoStageError({ code: 'INVALID', message: '不支持的操作' }, 'prepare').code).toBe('PHOTO_CONFIG');
  expect(diarySaveFeedback({ code: 'INTERNAL' }, 'confirm').title).toContain('云端确认');
  expect(diarySaveFeedback({ code: 'NETWORK' }, 'refresh').message).toContain('云端已确认写入日记');
});

test('执行日志保留固定故障分类和 HTTP 状态，拒绝原文、URL 与非法状态字段', () => {
  wx.clearStorageSync(); setCloudSession({ userId: 'demo-user', familyId: 'demo-family' });
  enableDeveloperMode(); setTraceEnabled(true);
  const trace = beginTrace()!;
  trace.emit('photo.failure', { path: 'upload', error: traceError(photoUploadError(undefined, 403)), httpStatus: 403 });
  trace.emit('photo.failure', { path: 'upload', error: 'https://upload.example/private?token=demo', httpStatus: 'private response' as any });
  const report = debugReport();
  expect(report).toContain('照片上传授权被拒绝'); expect(report).toContain('403');
  expect(report).not.toMatch(/private|token|upload\.example/);
});

test('记录卡组件在保存中阻止修改与重复操作，失败后恢复重试', () => {
  let definition: any; const previous = (global as any).Component;
  try {
    (global as any).Component = value => { definition = value; };
    jest.isolateModules(() => require('../../components/pending-card/index.ts'));
  } finally { (global as any).Component = previous; }
  const card = { ...definition.methods, data: { saveState: { busy: true }, draft: { key: 'demo' } }, triggerEvent: jest.fn() };
  card.onSave(); card.onEdit(); card.onDiscard(); card.onChip({ currentTarget: { dataset: { value: '2026-10-13' } } });
  expect(card.triggerEvent).not.toHaveBeenCalled();
  card.data.saveState.busy = false; card.onSave();
  expect(card.triggerEvent).toHaveBeenCalledWith('save', { key: 'demo' });
});

test('保存反馈只在多照片上传时显示真实张数，准备 / 确认阶段保留分类但不外显技术详情', () => {
  expect(saveProgressView({ stage: 'upload', photoIndex: 0, photoTotal: 1 }).label).toBe('正在上传照片…');
  expect(saveProgressView({ stage: 'upload', photoIndex: 1, photoTotal: 3 }).label).toBe('正在上传照片 2/3…');
  expect(saveProgressView({ stage: 'upload', photoIndex: 3, photoTotal: 3 }).label).toBe('正在上传照片…');
  for (const stage of ['local', 'read', 'authorize', 'confirm', 'photo-done', 'save', 'refresh'] as const) {
    expect(saveProgressView({ stage })).toEqual({ busy: true, stage, label: '正在保存日记…', detail: '' });
  }
});

test('日记编辑保存使用简短阶段标题，超时给分类弹窗并保留编辑内容', async () => {
  let definition: any; const previous = (global as any).Page;
  try {
    (global as any).Page = value => { definition = value; };
    require('../../pages/diary/diary.ts');
  } finally { (global as any).Page = previous; }
  const page = { ...definition, data: { ...definition.data, id: 'demo', record: { text: '演示', tags: [] }, editorVisible: true },
    setData(patch: any) { Object.assign(this.data, patch); } };
  (updateRecord as jest.Mock).mockImplementationOnce(async (_id, _patch, progress) => {
    progress({ stage: 'upload', photoIndex: 0, photoTotal: 2 });
    throw photoUploadError({ errMsg: 'request:fail timeout private details' });
  });
  const loading = jest.spyOn(wx, 'showLoading');
  try {
    await page.onEditorConfirm({ detail: { petId: 'demo', date: '2026-10-13', text: '演示', photos: [] } });
    expect(loading).toHaveBeenCalledWith({ title: '上传照片 1/2…', mask: true });
    expect(Dialog.alert).toHaveBeenCalledWith(expect.objectContaining({ title: '照片上传超时' }));
    expect(page.data.editorVisible).toBe(true); expect(page._saving).toBe(false);
  } finally { loading.mockRestore(); }
});
