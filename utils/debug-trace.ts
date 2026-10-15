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
}
export type TraceObserver = (phase: string, detail: TraceDetail) => void;
export interface DebugTrace { id: string; startedAt: number; status: string; durationMs: number; events: Array<{ phase: string; at: number; detail: TraceDetail }> }
export interface TraceHandle { id: string; emit: TraceObserver; finish: (status: string, detail?: TraceDetail) => void }
const key = (userId: string, familyId: string) => `jd_debug_${userId}_${familyId}_traces`;
export function isTraceEnabled(): boolean { return isDeveloperMode() && wx.getStorageSync(ENABLED) === true; }
export function setTraceEnabled(enabled: boolean): void { if (isDeveloperMode()) wx.setStorageSync(ENABLED, enabled); }

/** 默认不采集任意错误原文；防止服务商将请求头、正文或 Key 回显到报告。 */
export function traceError(error: any): string {
  const message = String(error?.message || '');
  if (['请求超时', '已取消', '日期校验失败', '原文依据校验失败', '工具或 JSON 参数校验失败', '身份或家庭作用域变化'].includes(message)) return message;
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
  if (out.tool && !['query_records', 'create_draft_record', 'read_session', 'read_conversation'].includes(out.tool)) out.tool = 'unknown';
  // 关键词只保留常见事件；任意查询文本可能带用户私人信息。
  if (typeof detail.keyword === 'string') out.keyword = /^(领养|收养|驱虫|疫苗|洗澡|玩耍|罐头|体重)$/.test(detail.keyword) ? detail.keyword : '[自定义关键词]';
  for (const field of ['startDate', 'endDateExclusive', 'date', 'proposedDate']) {
    const value = detail[field];
    if (value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))) out[field] = value;
  }
  for (const field of ['round', 'limit', 'offset', 'matched', 'drafts', 'durationMs', 'historyCount', 'step']) {
    const value = detail[field]; if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
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
export function debugReport(): string { return JSON.stringify({ version: 1, traces: getDebugTraces() }, null, 2); }
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
