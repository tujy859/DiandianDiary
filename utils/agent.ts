/**
 * Agent 编排：让模型自主决定是否调用工具，工具本身由本地确定性代码执行。
 * 关键约束：create_draft_record 只生成「待保存草稿」，正式入库依然要用户点「保存这条」。
 */
import { ModelConfig, Pet, DiaryRecord, getRecords, RefInfo } from './store';
import { chatTurn } from './llm';
import { findRuleByTag } from './intent';
import { today, diffDays, displayDate, relDay } from './date';

export interface AgentDraft {
  petId: string;
  date: string | null;
  text: string;
  tags: string[];
  photos: string[];
}

export interface AgentResult {
  reply: string;
  drafts: AgentDraft[];
  refs: RefInfo[];
  toolsUsed: string[];
}

export const TOOLS: any[] = [
  {
    type: 'function',
    function: {
      name: 'query_records',
      description: '查询已保存的日记记录。用于回答「上次什么时候」「几次」「多久」等问题，返回基于真实记录的确定性结果',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '事件关键词，如 洗澡、喂食、疫苗、驱虫' },
          limit: { type: 'integer', description: '返回条数，默认 3' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_draft_record',
      description: '把用户明确说出、已经发生的事情整理成待保存草稿（用户确认后才会正式保存）。计划、咨询、否定、闲聊都不要调用',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD，只取用户明确说出的时间；模糊则留空字符串' },
          text: { type: 'string', description: '整理后的一句话描述' },
          tags: { type: 'array', items: { type: 'string' }, description: '事件标签' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_records',
      description: '列出最近的几条日记概要，用于了解宠物近期情况',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '条数，默认 5' } },
      },
    },
  },
];

function queryRecords(petId: string, keyword: string, limit = 3) {
  const list = getRecords(petId);
  const rule = findRuleByTag(keyword);
  let matched: DiaryRecord[] = list;
  if (rule) {
    matched = list.filter(
      (r) => r.tags.indexOf(rule.tag) >= 0 || rule.words.some((w) => (r.text || '').indexOf(w) >= 0),
    );
  } else if (keyword) {
    matched = list.filter((r) => (r.text || '').indexOf(keyword) >= 0);
  }
  const top = matched.slice(0, limit || 3);
  if (!top.length) {
    return { summary: `时光册里还没有找到与「${keyword || '全部'}」相关的记录。`, records: [] as any[] };
  }
  const latest = top[0];
  const n = diffDays(latest.date, today());
  const summary = `共 ${matched.length} 条相关记录；最近一条是 ${latest.date}（${relDay(latest.date)}，距今 ${n} 天）：${latest.text || '（照片日记）'}`;
  return {
    summary,
    records: top.map((r) => ({ id: r.id, date: r.date, text: r.text, tags: r.tags })),
  };
}

function listRecent(petId: string, limit = 5) {
  const list = getRecords(petId).slice(0, limit || 5);
  if (!list.length) return { summary: '还没有任何记录。', records: [] as any[] };
  return {
    summary: list.map((r) => `${r.date} ${r.tags.length ? `[${r.tags.join('/')}] ` : ''}${r.text || '（照片日记）'}`).join('\n'),
    records: list.map((r) => ({ id: r.id, date: r.date, text: r.text, tags: r.tags })),
  };
}

export class AbortedError extends Error {
  constructor() {
    super('已停止生成');
    this.name = 'AbortedError';
  }
}

export async function runAgent(
  cfg: ModelConfig,
  userText: string,
  opts: {
    pet: Pet;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    photos: string[];
    abortToken?: { aborted: boolean };
  },
): Promise<AgentResult> {
  const { pet, history, photos } = opts;
  const records = getRecords(pet.id).slice(0, 20).map((r) => ({ date: r.date, text: r.text, tags: r.tags }));
  const drafts: AgentDraft[] = [];
  const refs: RefInfo[] = [];
  const toolsUsed: string[] = [];

  const messages: Array<Record<string, any>> = [
    {
      role: 'system',
      content: `你是「记一下喵」小程序里的宠物陪伴助手，陪用户记录宠物「${pet.name}」（${pet.species}）的生活。今天是 ${today()}。

可以调用的工具：
- 用户说了一件已经发生的事 → create_draft_record 生成待保存草稿（用户确认后才会保存）。
- 用户在查询过去记录 → query_records，结果由系统基于真实记录计算，你不要编造日期和次数。
- 需要了解宠物近况 → list_recent_records。

纪律：计划、咨询、否定（今天没做）、感叹闲聊，都不要调用 create_draft_record。日期只能来自用户明确说出的时间，模糊说法留空，绝不猜测。回复自然简短，不超过两句。

${pet.name}最近的记录（仅供参考，查询以工具返回为准）：
${records.length ? records.map((r) => `- ${r.date}${r.tags.length ? ` [${r.tags.join('/')}]` : ''} ${r.text || '（照片日记）'}`).join('\n') : '（暂无）'}`,
    },
    ...history,
    { role: 'user', content: userText },
  ];

  let final = '';
  for (let round = 0; round < 3; round++) {
    if (opts.abortToken && opts.abortToken.aborted) throw new AbortedError();
    const turn = await chatTurn(cfg, messages, TOOLS);
    messages.push(turn.message || { role: 'assistant', content: turn.content });

    if (!turn.toolCalls.length) {
      final = turn.content;
      break;
    }

    for (const call of turn.toolCalls) {
      let result: any = { ok: false, message: `未知工具 ${call.name}` };
      if (call.name === 'query_records') {
        result = queryRecords(pet.id, String((call.arguments && call.arguments.keyword) || ''), Number(call.arguments && call.arguments.limit) || 3);
        if (result.records && result.records.length) {
          const r0 = result.records[0];
          const snippet = r0.text ? `「${r0.text.slice(0, 20)}${r0.text.length > 20 ? '…' : ''}」` : '（照片日记）';
          refs.push({ recordId: r0.id, label: '查看那天的记录', sub: `${displayDate(r0.date)} ${snippet}` });
        }
      } else if (call.name === 'create_draft_record') {
        const args = call.arguments || {};
        const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : null;
        drafts.push({
          petId: pet.id,
          date,
          text: String(args.text || userText),
          tags: Array.isArray(args.tags) ? args.tags.filter((t: unknown) => typeof t === 'string') : [],
          photos: drafts.length === 0 ? photos : [],
        });
        result = { ok: true, message: '已生成待保存草稿，等待用户确认后才会正式保存。' };
      } else if (call.name === 'list_recent_records') {
        result = listRecent(pet.id, Number((call.arguments && call.arguments.limit) as any) || 5);
      }
      toolsUsed.push(call.name);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return { reply: final || (drafts.length ? '先帮你整理好了，确认后我就记进时光册。' : ''), drafts, refs, toolsUsed };
}
