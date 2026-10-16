import { getCloudSession, getCloudSessionEpoch, uid } from './store';
import { isDeveloperMode } from './developer';

export const MAX_TRACES = 12;
export const MAX_TRACE_EVENTS = 48;
const ENABLED = 'jd_debug_trace_enabled';
export interface TraceDetail {
  path?: string; round?: number; tool?: string; purpose?: string; eventType?: string;
  keyword?: string; startDate?: string; endDateExclusive?: string; mode?: string; limit?: number; offset?: number;
  matched?: number; records?: Array<{ id: string; date: string }>; date?: string | null; proposedDate?: string | null;
  drafts?: number; refs?: string[]; error?: string; status?: string; durationMs?: number; historyCount?: number; runId?: string; step?: number;
  photoIndex?: number; sourceBytes?: number; uploadBytes?: number; httpStatus?: number;
  /** 仅上传服务的 DNS 主机名，不接受完整 URL、路径或授权。 */
  uploadHost?: string;
}
export type TraceObserver = (phase: string, detail: TraceDetail) => void;
export interface DebugTrace { id: string; startedAt: number; status: string; durationMs: number; events: Array<{ phase: string; at: number; detail: TraceDetail }> }
export interface TraceHandle { id: string; emit: TraceObserver; finish: (status: string, detail?: TraceDetail) => void }
const key = (userId: string, familyId: string) => `jd_debug_${userId}_${familyId}_traces`;
export function isTraceEnabled(): boolean { return isDeveloperMode() && wx.getStorageSync(ENABLED) === true; }
export function setTraceEnabled(enabled: boolean): void { if (isDeveloperMode()) wx.setStorageSync(ENABLED, enabled); }

function safeUploadHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 253) return undefined;
  const host = value.toLowerCase(), labels = host.split('.');
  if (labels.length < 2 || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return undefined;
  return host;
}

/** 仅从服务端返回的 HTTPS 上传地址提取主机，原 URL 不进入诊断。 */
export function photoUploadHost(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(url);
  return match ? safeUploadHost(match[1]) : undefined;
}

/** 默认不采集任意错误原文；防止服务商将请求头、正文或 Key 回显到报告。 */
export function traceError(error: any): string {
  const message = String(error?.message || '');
  if (error?.code === 'PHOTO_READ') return '照片读取失败';
  if (error?.code === 'PHOTO_UPLOAD') return '照片上传失败';
  const photoErrors: Record<string, string> = { PHOTO_DOMAIN: '照片上传域名未配置', PHOTO_CONFIG: '照片上传接口未更新',
    PHOTO_NETWORK: '照片上传连接中断', PHOTO_TIMEOUT: '照片上传超时', PHOTO_AUTH: '照片上传授权被拒绝',
    PHOTO_TLS: '照片上传安全连接失败', PHOTO_SERVICE: '照片上传服务繁忙', PHOTO_CAPACITY: '照片上传服务容量限制',
    PHOTO_FORMAT: '照片格式不支持', PHOTO_EXPIRED: '照片上传授权过期' };
  if (photoErrors[error?.code]) return photoErrors[error.code];
  if (Object.values(photoErrors).includes(message)) return message;
  if (['请求超时', '已取消', '日期校验失败', '原文依据校验失败', '工具或 JSON 参数校验失败', '身份或家庭作用域变化', '照片读取失败', '照片上传失败', '照片大小超限', '照片格式不支持'].includes(message)) return message;
  if (/照片.*(?:超过|超限)|file size.*exceed/i.test(message)) return '照片大小超限';
  if (/^请选择支持的照片格式/.test(message)) return '照片格式不支持';
  const http = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (http) return `HTTP ${http[1]}`;
  if (/timeout|超时/i.test(message)) return '请求超时';
  if (/取消|已停止/.test(message)) return '已取消';
  if (/日期|日历/.test(message)) return '日期校验失败';
  if (/sourceText|原话|事实原文/.test(message)) return '原文依据校验失败';
  if (/参数|未知|JSON|字段/.test(message)) return '工具或 JSON 参数校验失败';
  if (/账号|家庭|权限/.test(message)) return '身份或家庭作用域变化';
  return '调用失败，请结合步骤和工具结果检查';
}
function clean(detail: TraceDetail): TraceDetail {
  const out: any = {};
  for (const field of ['path', 'tool', 'purpose', 'eventType', 'mode', 'status', 'runId']) {
    const value = detail[field];
    if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,48}$/.test(value)) out[field] = value;
  }
  if (out.tool && !['query_records', 'create_draft_record', 'update_draft_record', 'read_session', 'read_conversation'].includes(out.tool)) out.tool = 'unknown';
  // 关键词只保留常见事件；任意查询文本可能带用户私人信息。
  if (typeof detail.keyword === 'string') out.keyword = /^(领养|收养|驱虫|疫苗|洗澡|玩耍|罐头|体重)$/.test(detail.keyword) ? detail.keyword : '[自定义关键词]';
  for (const field of ['startDate', 'endDateExclusive', 'date', 'proposedDate']) {
    const value = detail[field];
    if (value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))) out[field] = value;
  }
  for (const field of ['round', 'limit', 'offset', 'matched', 'drafts', 'durationMs', 'historyCount', 'step']) {
    const value = detail[field]; if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  for (const field of ['photoIndex', 'sourceBytes', 'uploadBytes']) {
    const value = detail[field]; if (Number.isSafeInteger(value) && value >= 0) out[field] = value;
  }
  if (Number.isInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599) out.httpStatus = detail.httpStatus;
  const uploadHost = safeUploadHost(detail.uploadHost);
  if (uploadHost) out.uploadHost = uploadHost;
  const safeId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  if (Array.isArray(detail.refs)) out.refs = detail.refs.filter(safeId).slice(0, 20);
  if (Array.isArray(detail.records)) out.records = detail.records.filter(r => r && safeId(r.id) && /^\d{4}-\d{2}-\d{2}$/.test(r.date)).slice(0, 20).map(r => ({ id: r.id, date: r.date }));
  if (detail.error) out.error = traceError({ message: detail.error });
  return out;
}
export function getDebugTraces(): DebugTrace[] {
  const s = getCloudSession();
  if (!isDeveloperMode() || !s?.familyId) return [];
  const rows = wx.getStorageSync(key(s.userId, s.familyId));
  if (!Array.isArray(rows)) return [];
  return rows.slice(-MAX_TRACES).filter(r => r && typeof r.id === 'string' && Array.isArray(r.events)).map(r => ({
    id: r.id, startedAt: Number(r.startedAt) || 0, status: /^[a-z_-]+$/.test(r.status) ? r.status : 'unknown', durationMs: Number(r.durationMs) || 0,
    events: r.events.slice(-MAX_TRACE_EVENTS).map(e => ({ phase: /^[a-z_.-]+$/.test(e.phase) ? e.phase : 'unknown', at: Number(e.at) || 0, detail: clean(e.detail || {}) })),
  }));
}
export function clearDebugTraces(): void {
  const s = getCloudSession(); if (isDeveloperMode() && s) wx.removeStorageSync(key(s.userId, s.familyId));
}
export function debugReport(traceId?: string): string {
  const traces = getDebugTraces();
  return JSON.stringify({ version: 1, traces: traceId === undefined ? traces : traces.filter(row => row.id === traceId) }, null, 2);
}
export function beginTrace(detail: TraceDetail = {}): TraceHandle | undefined {
  const s = getCloudSession();
  if (!isTraceEnabled() || !s?.familyId) return undefined;
  const epoch = getCloudSessionEpoch(), id = uid(), startedAt = Date.now();
  const scopedKey = key(s.userId, s.familyId);
  const valid = () => {
    const current = getCloudSession();
    return isTraceEnabled() && epoch === getCloudSessionEpoch() && current?.userId === s.userId && current.familyId === s.familyId;
  };
  const mutate = (work: (row: DebugTrace) => void) => {
    try {
      if (!valid()) return;
      const rows = getDebugTraces(), row = rows.find(r => r.id === id);
      if (!row) return;
      work(row); wx.setStorageSync(scopedKey, rows);
    } catch (_) { /* 调试存储不可影响正式聊天。 */ }
  };
  try {
    const rows = getDebugTraces();
    rows.push({ id, startedAt, status: 'running', durationMs: 0, events: [] });
    wx.setStorageSync(scopedKey, rows.slice(-MAX_TRACES));
  } catch (_) { return undefined; }
  const emit: TraceObserver = (phase, data) => mutate(row => {
    row.events.push({ phase, at: Date.now(), detail: clean(data) });
    row.events = row.events.slice(-MAX_TRACE_EVENTS);
  });
  emit('request.start', detail);
  return { id, emit, finish: (status, data = {}) => {
    emit('request.finish', { ...data, status, durationMs: Date.now() - startedAt });
    mutate(row => { row.status = status; row.durationMs = Date.now() - startedAt; });
  } };
}
