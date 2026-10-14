/**
 * 话题会话管理：以上下文边界（分隔条）为一等公民。
 *
 * 三个消费方统一以「最后一条分隔条」为界：
 * 1. AI 对话历史 —— 只带当前会话，旧话题不污染新对话；
 * 2. 草稿取证窗口 —— 事实必须来自当前会话内的用户原话（不再是写死的最近两句）；
 * 3. 未认领照片池 —— 本会话内用户发过、但还没被待确认/已保存草稿使用的照片，
 *    后续说「记一下」时自动带上；草稿被丢弃/保存失败后照片自动释放。
 */
import { ChatMessage, uid } from './store';
import { fmt } from './date';

export interface ConversationLine {
  role: 'user' | 'assistant'; content: string; referenceDate?: string;
}

/** 30 分钟没有新消息，页面可见时提前开启新话题并显示分隔提示 */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export function isDivider(m: ChatMessage): boolean {
  return m.kind === 'divider';
}

/** 当前会话 = 最后一条分隔条之后的消息；没有分隔条时整段历史视为同一会话（兼容旧数据） */
export function currentSessionMessages(messages: ChatMessage[]): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isDivider(messages[i])) return messages.slice(i + 1);
  }
  return messages.slice();
}

/**
 * 会话内「未认领」照片：用户发过、但还没进入任何待确认/已保存草稿的照片。
 * 按发送顺序去重返回；草稿被丢弃或保存失败后，其照片自动回到池中。
 */
export function unclaimedPhotos(messages: ChatMessage[]): string[] {
  const session = currentSessionMessages(messages);
  const claimed = new Set<string>();
  session.forEach((m) => {
    if (m.draft && (m.draft.status === 'pending' || m.draft.status === 'saved')) {
      (m.draft.photos || []).forEach((p) => claimed.add(p));
    }
  });
  const pool: string[] = [];
  session.forEach((m) => {
    if (m.role !== 'user') return;
    (m.photos || []).forEach((p) => {
      if (!claimed.has(p) && pool.indexOf(p) < 0) pool.push(p);
    });
  });
  return pool;
}

/** 上下文字符预算：整个话题都带，超预算才从最早处省略（不再用固定条数截断） */
export const HISTORY_BUDGET = 12000;

/** 流程性提示不进上下文：模型看到「待确认草稿」会误以为还没保存，反复提醒用户 */
const HISTORY_NOISE = /^(已整理为待确认草稿|这次没有生成记录卡|已停止生成)/;

/** 供模型使用的对话历史：当前话题的全部自然语言消息，按字符预算从最早处省略 */
export function buildHistory(
  messages: ChatMessage[],
  budget = HISTORY_BUDGET,
  includeDates = false,
): ConversationLine[] {
  const rows = currentSessionMessages(messages)
    .filter((m) => (m.kind === 'text' || m.kind === 'query') && m.text && !m.retry && !HISTORY_NOISE.test(m.text));
  const picked: ConversationLine[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const content = includeDates && rows[i].role === 'user' && rows[i].sourceText !== undefined
      ? rows[i].sourceText! : rows[i].text!;
    if (used + content.length > budget && picked.length) break;
    used += content.length;
    const row: ConversationLine = { role: rows[i].role === 'user' ? 'user' : 'assistant', content };
    if (includeDates && Number.isFinite(rows[i].time)) row.referenceDate = fmt(new Date(rows[i].time));
    picked.unshift(row);
  }
  return picked;
}

/** 生成话题分隔条（持久化在消息流里，重进页面仍然可见） */
export function makeDivider(auto: boolean, now = new Date()): ChatMessage {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return {
    id: uid(),
    role: 'ai',
    kind: 'divider',
    text: `${auto ? '已间隔30分钟，开启新话题' : '新话题开始'} · ${time} · 之前的对话可在「话题」查看`,
    time: now.getTime(),
  };
}
