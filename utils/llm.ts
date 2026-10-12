/**
 * 真实模型调用（OpenAI 兼容协议，如 DeepSeek）。
 * 支持两种模式：
 * 1. 工具调用（function calling）：模型自主决定调用 query_records / create_draft_record 等工具，本地确定性执行；
 * 2. 结构化 JSON 模式：模型只输出 JSON，作为工具调用不可用时的降级方案。
 * 无论哪种模式，正式保存都必须由用户点「保存这条」确认。
 */
import { ModelConfig } from './store';

export interface LlmContext {
  petName: string;
  species: string;
  today: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  records: Array<{ date: string; text: string; tags: string[] }>;
}

export interface LlmOutput {
  reply: string;
  draft: { date: string | null; tags: string[]; text: string } | null;
  queryTag: string | null;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface LlmTurn {
  content: string;
  toolCalls: LlmToolCall[];
  message: any;
}

export function isModelReady(cfg: ModelConfig): boolean {
  return !!(cfg && cfg.apiKey && cfg.baseUrl && cfg.model);
}

function buildSystemPrompt(ctx: LlmContext): string {
  const recordsText = ctx.records.length
    ? ctx.records
        .map((r) => `- ${r.date}${r.tags.length ? ` [${r.tags.join('/')}]` : ''} ${r.text || '（照片日记）'}`)
        .join('\n')
    : '（暂无）';
  return `你是「记一下喵」小程序里的宠物陪伴助手，陪用户记录宠物「${ctx.petName}」（${ctx.species}）的生活。今天是 ${ctx.today}。

你可以调用工具：
- 用户说了一件「已经发生」的事 → 调用 create_draft_record 生成待保存草稿（用户确认后才会保存，你不会直接写入）。
- 用户问「上次/什么时候/几次/多久」→ 调用 query_records，由系统基于真实记录给出确定答案，你不要编造日期和次数。
- 需要了解宠物近期情况 → 调用 list_recent_records。

纪律：计划将来要做的事、咨询、否定（今天没做）、感叹闲聊，都不要调用 create_draft_record。日期只能来自用户明确说出的时间（今天/昨天/前天/X月X日），模糊说法（上周左右）留空，绝不猜测。

回复要像朋友一样自然、简短，不超过两句。

${ctx.petName}最近的记录（仅供参考，查询以工具返回为准）：
${recordsText}`;
}

function extractJson(content: string): LlmOutput {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return { reply: content, draft: null, queryTag: null };
  try {
    const obj = JSON.parse(m[0]);
    const draft = obj.draft && typeof obj.draft === 'object'
      ? {
          date: typeof obj.draft.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.draft.date) ? obj.draft.date : null,
          tags: Array.isArray(obj.draft.tags) ? obj.draft.tags.filter((t: unknown) => typeof t === 'string') : [],
          text: typeof obj.draft.text === 'string' ? obj.draft.text : '',
        }
      : null;
    return {
      reply: typeof obj.reply === 'string' ? obj.reply : '',
      draft,
      queryTag: typeof obj.queryTag === 'string' ? obj.queryTag : null,
    };
  } catch (e) {
    return { reply: content, draft: null, queryTag: null };
  }
}

function rawRequest(cfg: ModelConfig, payload: Record<string, any>): Promise<any> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'POST',
      timeout: 45000,
      header: {
        'content-type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      data: payload,
      success(res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const data: any = res.data || {};
          const msg = (data.error && (data.error.message || data.error.code)) || `HTTP ${res.statusCode}`;
          reject(new Error(String(msg)));
          return;
        }
        const data: any = res.data || {};
        if (!data.choices || !data.choices.length) {
          reject(new Error('模型返回为空'));
          return;
        }
        resolve(data);
      },
      fail(err) {
        reject(new Error(err.errMsg || '网络错误'));
      },
    });
  });
}

function parseArgs(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    return {};
  }
}

/** 单轮对话，支持 tools；返回最终文本与待执行的工具调用 */
export async function chatTurn(
  cfg: ModelConfig,
  messages: Array<Record<string, any>>,
  tools?: any[],
): Promise<LlmTurn> {
  const payload: Record<string, any> = { model: cfg.model, messages, temperature: 0.3 };
  if (tools && tools.length) {
    payload.tools = tools;
  }
  const data = await rawRequest(cfg, payload);
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const toolCalls: LlmToolCall[] = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((c: any) => ({
        id: c.id,
        name: (c.function && c.function.name) || '',
        arguments: parseArgs(c.function && c.function.arguments),
      }))
    : [];
  return { content: msg.content || '', toolCalls, message: msg };
}

/** JSON 结构化模式（工具调用不可用时的降级方案） */
export async function chatWithModel(cfg: ModelConfig, userText: string, ctx: LlmContext): Promise<LlmOutput> {
  const messages = [
    { role: 'system', content: buildSystemPrompt(ctx) },
    ...ctx.history,
    { role: 'user', content: userText },
  ];
  const data = await rawRequest(cfg, { model: cfg.model, messages, temperature: 0.3 });
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const content = String(msg.content || '');
  if (!content) throw new Error('模型返回为空');
  return extractJson(content);
}

/** JSON 模式专用提示（chatWithModel 复用同一 system prompt） */
export async function testConnection(cfg: ModelConfig): Promise<string> {
  const data = await rawRequest(cfg, {
    model: cfg.model,
    messages: [{ role: 'user', content: '你好，请用一句话介绍你自己。' }],
    temperature: 0.3,
  });
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  return String(msg.content || '').slice(0, 60);
}
