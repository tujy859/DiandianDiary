/**
 * 聊天会话：一话题一文档上云，本机按话题保留快照及当前话题。
 * - 换设备：本机没有会话 → 自动新建会话（另一台设备默认开新聊天）
 * - 旧会话：目录里点开即切换为当前会话，可以接着聊
 * - 照片：云端只存 fileId，打开会话时统一换成可展示链接，同时保留 fileId 供草稿保存复用
 */
import { ChatMessage, Draft, ModelConfig, getCloudSession, getCloudSessionEpoch, uid } from './store';
import { callCloud } from './cloud';
import { cloudFileIds, resolvePhotoUrls } from './repository';
import { summarizeSession, summarizeTitle } from './llm';

/** 单会话消息上限：上下文本来就只带一个话题，超过就提示开新话题 */
export const MAX_MESSAGES = 100;
/** 摘要上限（与服务端 120 字校验一致） */
const SUMMARY_LIMIT = 120;

export interface SessionIndex {
  id: string;
  title: string;
  summary: string;
  messageCount: number;
  startedAt: number;
  updatedAt: number;
  version: number;
}

export interface ChatSession {
  id: string;
  /** 幂等创建用的客户端标识：同一会话首次落库后由服务端返回 id */
  clientId: string;
  version: number;
  title: string;
  summary: string;
  messages: ChatMessage[];
  dirty?: boolean;
  localRevision?: number;
}

function localKey(petId: string): string {
  const s = getCloudSession();
  return `jd_chat_${s ? `${s.userId}_${s.familyId}` : 'local'}_${petId}`;
}

export function loadLocalSession(petId: string): ChatSession | null {
  const raw = wx.getStorageSync(localKey(petId));
  if (!raw || !Array.isArray(raw.messages)) return null;
  return {
    id: String(raw.id || ''),
    clientId: String(raw.clientId || uid()),
    version: Number(raw.version) || 0,
    title: String(raw.title || ''),
    summary: String(raw.summary || ''),
    messages: raw.messages,
    dirty: raw.dirty === true,
    localRevision: Number(raw.localRevision) || 0,
  };
}

export function saveLocalSession(petId: string, session: ChatSession): void {
  const previous = loadLocalSession(petId);
  if (previous) saveSessionSnapshot(petId, previous);
  saveSessionSnapshot(petId, session);
  wx.setStorageSync(localKey(petId), session);
}

/** 与当前槽位共用账号/家庭前缀，退出及权限清理会一并移除。 */
export function saveSessionSnapshot(petId: string, session: ChatSession): void {
  wx.setStorageSync(`${localKey(petId)}:topic:${session.id || session.clientId}`, session);
  if (session.id) wx.removeStorageSync(`${localKey(petId)}:topic:${session.clientId}`);
}

function localSnapshot(petId: string, id: string): ChatSession | null {
  const current = loadLocalSession(petId);
  if (current?.id === id) return current;
  const saved = wx.getStorageSync(`${localKey(petId)}:topic:${id}`);
  return saved && Array.isArray(saved.messages) ? saved : null;
}

function localTopics(petId: string): ChatSession[] {
  const prefix = `${localKey(petId)}:topic:`;
  return (wx.getStorageInfoSync().keys as string[]).filter(k => k.startsWith(prefix))
    .map(k => wx.getStorageSync(k)).filter(s => s && Array.isArray(s.messages));
}

/** 新会话：新的 clientId 保证服务端幂等，且不会串到别的会话上 */
export function newSession(): ChatSession {
  return { id: '', clientId: uid(), version: 0, title: '', summary: '', messages: [] };
}

/** 只有真正入库（保存进日记）的照片才会上云：同步时非 fileId 的一律留在本机 */
const isCloudId = (p: string) => !!p && p.indexOf('cloud://') === 0;

/** 云端从未见过的本机照片按消息/卡片身份恢复，不能复活已删除的云端照片。 */
function restoreLocalPhotos(remote: ChatSession, local: ChatSession): ChatSession {
  const unsaved = (photos: string[] = [], ids: string[] = []) => photos.filter((p, i) => !ids[i] && !isCloudId(p) && !/^https:/.test(p));
  return { ...remote, clientId: local.clientId, messages: remote.messages.map(message => {
    const previous = local.messages.find(m => m.id === message.id);
    if (!previous) return message;
    const photos = [...new Set((message.photos || []).concat(unsaved(previous.photos, previous.photoIds)))];
    const result = { ...message, photos };
    if (message.draft && previous.draft?.key === message.draft.key && ['pending', 'failed'].includes(message.draft.status)) {
      const draft = { ...message.draft, photos: [...new Set(message.draft.photos.concat(unsaved(previous.draft.photos, previous.draft.photoIds)))] };
      if (draft.rawInput && previous.draft.rawInput) draft.rawInput = { ...draft.rawInput,
        photos: [...new Set(draft.rawInput.photos.concat(unsaved(previous.draft.rawInput.photos)))] };
      result.draft = draft;
    }
    return result;
  }) };
}

function fromCloud(m: any, urls: Record<string, string>, petId: string): ChatMessage {
  const photos = (m.photos || []).map((id: string) => urls[id] || id);
  const draftPhotos = ((m.draft && m.draft.photos) || []).map((id: string) => urls[id] || id);
  const msg: ChatMessage = {
    id: m.id,
    role: m.role === 'user' ? 'user' : 'ai',
    kind: m.kind,
    text: m.text,
    photos,
    photoIds: m.photos || [],
    mode: m.mode,
    time: m.time,
  };
  if (m.refs && m.refs.length) msg.refs = m.refs;
  if (m.draft) {
    const draft: Draft = {
      key: m.draft.key,
      petId,
      date: m.draft.date || null,
      text: m.draft.text,
      tags: m.draft.tags || [],
      photos: draftPhotos,
      photoIds: m.draft.photos || [],
      status: m.draft.status,
      rawInput: m.draft.rawInput || undefined,
    };
    if (m.draft.recordId) draft.recordId = m.draft.recordId;
    msg.draft = draft;
  }
  return msg;
}

/** 会话目录：只取索引，正文按需拉取 */
export async function listSessions(petId: string): Promise<SessionIndex[]> {
  const s = getCloudSession();
  const epoch = getCloudSessionEpoch();
  if (!s) return [];
  const items: SessionIndex[] = [];
  let after = '';
  do {
    const page = await callCloud<{ items: SessionIndex[]; next: string }>('session.list', { familyId: s.familyId, petId, after, limit: 20 });
    assertScope(s, epoch);
    items.push(...(page.items || []));
    after = page.next || '';
  } while (after);
  for (const local of localTopics(petId)) {
    if (!local.dirty || items.some(item => item.id === local.id)) continue;
    items.push({ id: local.id || `local:${local.clientId}`, title: local.title || '本机未同步话题',
      summary: local.summary, messageCount: local.messages.length, version: local.version,
      startedAt: local.messages[0]?.time || 0, updatedAt: local.messages[local.messages.length - 1]?.time || 0 });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function hydrate(doc: any, petId: string): Promise<ChatSession> {
  const rows: any[] = doc.messages || [];
  const ids: string[] = [];
  rows.forEach((m) => {
    (m.photos || []).forEach((id: string) => ids.push(id));
    ((m.draft && m.draft.photos) || []).forEach((id: string) => ids.push(id));
  });
  const urls = await resolvePhotoUrls(ids);
  return {
    id: doc.id,
    clientId: String(doc.clientId || uid()),
    version: doc.version,
    title: doc.title || '',
    summary: doc.summary || '',
    messages: rows.map((m) => fromCloud(m, urls, petId)),
  };
}

/** 打开历史会话：拉取正文并切换为本机当前会话 */
export async function readSession(petId: string, id: string): Promise<ChatSession> {
  const s = getCloudSession();
  const epoch = getCloudSessionEpoch();
  if (!s) throw new Error('请先登录');
  if (id.startsWith('local:')) {
    const local = localTopics(petId).find(item => item.clientId === id.slice(6) && !item.id);
    if (!local) throw new Error('本机话题不存在');
    return local;
  }
  const doc = await callCloud<any>('session.get', { familyId: s.familyId, petId, id });
  assertScope(s, epoch);
  const result = await hydrate(doc, petId);
  assertScope(s, epoch);
  const local = localSnapshot(petId, id);
  // 同版本的云端内容不包含尚未确认的本机照片，不能用它覆盖完整快照。
  if (local?.dirty) return local;
  if (local && local.version === result.version) return { ...local, title: result.title, summary: result.summary };
  return local ? restoreLocalPhotos(result, local) : result;
}

export async function openSession(petId: string, id: string): Promise<ChatSession> {
  const session = await readSession(petId, id);
  saveLocalSession(petId, session);
  return session;
}

/** 拉取当前会话的云端最新版本；本机有未同步改动时保留本机 */
export async function pullSession(petId: string, session: ChatSession): Promise<ChatSession> {
  if (!session.id || session.dirty) return session;
  const latest = await readSession(petId, session.id);
  if (latest.version > session.version) return latest;
  return { ...session, title: latest.title, summary: latest.summary };
}

/**
 * 保存会话：只同步已经上云（保存进日记）的照片，其余留在本机；版本号防覆盖。
 * cacheLocal=false 时只写云端——例如切换话题后补推旧会话，不能把旧会话写回「当前会话」槽位。
 */
export async function pushSession(petId: string, session: ChatSession, cacheLocal = true): Promise<ChatSession> {
  const s = getCloudSession();
  const epoch = getCloudSessionEpoch();
  if (!s) throw new Error('请先登录');
  if (session.messages.length > MAX_MESSAGES) throw new Error('当前话题已满，请开启新话题后继续');
  // 照片不在这里上传：发送时只存本机路径，入库与否由「有没有保存进日记」决定
  const pick = (photos: string[] = [], ids?: string[]) => photos
    .map((p, i) => (ids && isCloudId(ids[i]) ? ids[i] : (isCloudId(p) ? p : '')))
    .filter(Boolean);

  const messages = session.messages.map((m) => {
    const row: any = {
      id: m.id, role: m.role, kind: m.kind, text: m.text || '', photos: pick(m.photos, m.photoIds), time: m.time, mode: m.mode || 'manual',
    };
    if (m.refs && m.refs.length) {
      row.refs = m.refs.slice(0, 20).map((r) => ({ recordId: r.recordId, label: r.label, sub: r.sub }));
    }
    if (m.draft) {
      row.draft = {
        key: m.draft.key, date: m.draft.date || '', text: m.draft.text, tags: m.draft.tags,
        photos: pick(m.draft.photos, m.draft.photoIds), status: m.draft.status,
        // 原文里的照片同样只带已入库的
        rawInput: m.draft.rawInput ? { ...m.draft.rawInput, photos: pick(m.draft.rawInput.photos) } : undefined,
      };
      if (m.draft.recordId) row.draft.recordId = m.draft.recordId;
    }
    return row;
  });
  const payload = {
    familyId: s.familyId, petId,
    id: session.id || undefined,
    clientId: session.clientId,
    version: session.id ? session.version : undefined,
    title: session.title, summary: session.summary, messages,
  };
  let doc = await callCloud<any>('session.save', payload);
  if (!session.id && Array.isArray(doc.messages)) {
    // 首次请求已写入但响应丢失时，幂等创建可能返回较早快照；不能把新增本机内容误标为已同步。
    const matches = (actual: any, expected: any): boolean => {
      if (expected === undefined) return true;
      if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matches(actual[i], v));
      if (expected && typeof expected === 'object') return !!actual && Object.keys(expected).every(k => matches(actual[k], expected[k]));
      return actual === expected;
    };
    if (!matches(doc.messages, messages) || doc.title !== session.title || doc.summary !== session.summary) {
      assertScope(s, epoch);
      doc = await callCloud<any>('session.save', { ...payload, id: doc.id, version: doc.version });
    }
  }
  // 服务端只收已入库的照片；回包不能覆盖本机尚未保存的照片、重试信息和原始输入。
  const saved: ChatSession = { ...session, id: doc.id, version: doc.version, dirty: false };
  assertScope(s, epoch);
  if (cacheLocal) saveLocalSession(petId, saved);
  else {
    const newer = localTopics(petId).find(item => item.clientId === session.clientId
      && (item.localRevision || 0) > (session.localRevision || 0));
    saveSessionSnapshot(petId, newer ? { ...newer, id: doc.id, version: doc.version } : saved);
  }
  return saved;
}

function assertScope(expected: { userId: string; familyId: string }, epoch: number) {
  const current = getCloudSession();
  if (!current || current.userId !== expected.userId || current.familyId !== expected.familyId
    || epoch !== getCloudSessionEpoch()) throw new Error('账号或家庭空间已切换，请重试');
}

/** 标题兜底：在标点处收尾，避免切出半句话 */
function fallbackTitle(text: string): string {
  const clean = String(text || '').trim();
  if (!clean) return '';
  if (clean.length <= 20) return clean;
  const cut = clean.slice(0, 20);
  const stop = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('、'), cut.lastIndexOf(' '));
  return `${stop >= 10 ? cut.slice(0, stop) : cut}…`;
}

/** 会话标题：模型给 10–20 字；超长时让模型重新压缩一次；仍不合规就用首句兜底 */
export async function generateTitle(cfg: ModelConfig, userTexts: string[]): Promise<string> {
  if (!userTexts.length) return '';
  try {
    let title = await summarizeTitle(cfg, userTexts);
    if (!title || title.length > 20) {
      const retry = await summarizeTitle(cfg, userTexts.concat([`上一次的标题「${title}」太长了，压缩到 20 字以内，只输出标题。`]));
      if (retry) title = retry;
    }
    if (title && title.length <= 24) return title;
  } catch (e) { /* 标题失败不影响聊天，走兜底 */ }
  return fallbackTitle(userTexts[0]);
}

/** 摘要兜底：取第一句用户原话，在标点处收尾，避免切出半句话 */
function fallbackSummary(lines: string[]): string {
  const first = String((lines[0] || '').replace(/^用户：|^助手：/, '')).trim();
  if (!first) return '';
  if (first.length <= SUMMARY_LIMIT) return first;
  const cut = first.slice(0, SUMMARY_LIMIT);
  const stop = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('、'), cut.lastIndexOf(' '));
  return `${stop >= 30 ? cut.slice(0, stop) : cut}…`;
}

/**
 * 会话收尾元数据：标题 + 摘要。
 * 标题已有就不重写；摘要每次收尾都刷新（话题内容会变长）。
 * 超长时让模型重新压缩一次，而不是机械截断。
 */
export async function generateSessionMeta(
  cfg: ModelConfig,
  session: ChatSession,
  lines: string[],
): Promise<{ title: string; summary: string }> {
  if (!lines.length) return { title: session.title || '', summary: session.summary || '' };
  const userTexts = session.messages
    .filter((m) => m.role === 'user' && m.kind === 'text' && m.text)
    .map((m) => m.text!);
  const title = session.title || (userTexts.length ? await generateTitle(cfg, userTexts) : '');
  let summary = '';
  try {
    summary = await summarizeSession(cfg, lines);
    if (!summary || summary.length > SUMMARY_LIMIT) {
      const retry = await summarizeSession(cfg, lines.concat([`上一次的摘要太长了，压缩到 ${SUMMARY_LIMIT} 字以内，只输出摘要。`]));
      if (retry) summary = retry;
    }
  } catch (e) { /* 摘要失败不影响会话，走兜底 */ }
  if (!summary) summary = fallbackSummary(lines);
  return { title, summary: summary.slice(0, SUMMARY_LIMIT) };
}

export async function removeSession(petId: string, id: string): Promise<void> {
  const s = getCloudSession();
  const epoch = getCloudSessionEpoch();
  if (!s) return;
  if (id.startsWith('local:')) {
    wx.removeStorageSync(`${localKey(petId)}:topic:${id.slice(6)}`);
    if (loadLocalSession(petId)?.clientId === id.slice(6)) wx.removeStorageSync(localKey(petId));
    return;
  }
  await callCloud('session.delete', { familyId: s.familyId, petId, id });
  assertScope(s, epoch);
  wx.removeStorageSync(`${localKey(petId)}:topic:${id}`);
  if (loadLocalSession(petId)?.id === id) wx.removeStorageSync(localKey(petId));
}
