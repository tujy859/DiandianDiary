import { hasYearExpression, isValidDate, parseDateWords, today } from './date';
import { extractTags } from './intent';
import type { Draft, RawInput } from './store';

export interface UserSource { content: string; referenceDate?: string }
export interface DraftState {
  key?: string; petId?: string; date?: string | null; text: string; tags?: string[]; status: string;
}
export interface DraftUpdateInput {
  key: string; sourceText: string; targetText?: string; date?: string; text?: string; tags?: string[]; dateSources?: string[];
}
export interface DraftUpdate {
  key: string; expected: DraftState; patch: Partial<Pick<Draft, 'date' | 'text' | 'tags'>>; correction: string;
}

function findSource(evidence: unknown, sources: UserSource[]): UserSource {
  const source = typeof evidence === 'string' && evidence.trim() && sources.find(row => row.content.includes(evidence));
  if (!source) throw new Error('请从当前话题的用户原话中选择事实依据，不能使用助手建议或编造原文');
  return source;
}

/** 只从模型选中的用户证据取日期；跨轮年份与月日按各自消息的参考日期组合。 */
export function resolveDraftDate(evidence: string, source: UserSource, dateSources: unknown, sources: UserSource[], referenceDate: string): string | null {
  if (dateSources !== undefined && (!Array.isArray(dateSources) || dateSources.length > 4
    || dateSources.some(text => typeof text !== 'string' || !text.trim()))) throw new Error('日期依据必须是最多四段用户原话');
  const selected = ((dateSources || []) as string[]).map(text => ({ text, source: findSource(text, sources) }));
  const prefix = source.content.slice(0, source.content.indexOf(evidence));
  const fragment = prefix.match(/(?:今年|去年|前年|明年|后年)(?:的)?(?:\s*\d{1,2}\s*月)?\s*$|[\d零〇○一二三四五六七八九年/月日号.\-\s]+[，,:：]?\s*$/)?.[0] || '';
  const datePrefix = hasYearExpression(fragment) || /月|\d{4}\s*[-/.]/.test(fragment) ? fragment : '';
  const rows = [{ text: datePrefix + evidence, source }, ...selected];
  const years: number[] = [];
  // 独立年份补充只接受用户明确选出的依据，不能从其他事件自动借年份。
  for (const row of selected) {
    const tokens = row.text.match(/今年|去年|前年|明年|后年|(?:\d+|[零〇○一二三四五六七八九十两]+)\s*年|\d{4}(?=[-/.]\d{1,2}[-/.]\d{1,2})/g) || [];
    for (const token of tokens) {
      // 复用同一年份规则，避免跨轮组合又维护一套世纪展开策略。
      const parsed = parseDateWords(`${/^\d{4}$/.test(token) ? token + '年' : token}1月1日`, row.source.referenceDate || referenceDate);
      const value = parsed && Number(parsed.slice(0, 4));
      if (!value || years.some(old => old !== value)) return null;
      years.push(value);
    }
  }
  let unresolved = false;
  const dates: string[] = [];
  for (const row of rows) {
    for (const part of row.text.split(/[，,。；;！？!?\n]/)) {
      // 这是补记动作的时间，不是事件发生时间；含事件的「今天洗澡了」仍正常解析。
      if (/^\s*(?:我)?(?:今天|刚刚|刚才)(?:想|要|来|帮我|补记|补录|把)/.test(part)) continue;
      const monthDay = part.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
      const yearOnly = years.length && hasYearExpression(part) && !monthDay
        && !/\d{4}[-/.]/.test(part) && selected.some(item => item.text.includes(part.trim()));
      if (yearOnly) continue;
      const value = years.length && monthDay && !hasYearExpression(part)
        ? parseDateWords(`${years[0]}年${monthDay[1]}月${monthDay[2]}日`, row.source.referenceDate || referenceDate)
        : parseDateWords(part, row.source.referenceDate || referenceDate);
      if ((hasYearExpression(part) || monthDay) && !value) unresolved = true;
      if (value && years.length && Number(value.slice(0, 4)) !== years[0]) unresolved = true;
      if (value) dates.push(value);
    }
  }
  const unique = Array.from(new Set(dates));
  return !unresolved && unique.length === 1 ? unique[0] : null;
}

/** 只验证修改方案，页面在模型结束后检查最新状态并应用，停止/失败不会留下半次修改。 */
export function validateDraftUpdate(args: DraftUpdateInput, states: DraftState[], input: { text: string; originalText?: string; petId: string; userHistory?: UserSource[] }, referenceDate = today()): DraftUpdate {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !['key', 'sourceText', 'targetText', 'date', 'text', 'tags', 'dateSources'].includes(key))) throw new Error('草稿修改字段无效');
  const state = states.find(row => row.key === args.key && row.petId === input.petId);
  if (!state || state.status !== 'pending') throw new Error('只能修改当前话题的待确认草稿；已保存记录请从时光册编辑');
  if (typeof args.sourceText !== 'string' || !args.sourceText.trim() || !input.text.includes(args.sourceText)) throw new Error('更正依据必须来自本轮用户原话');
  const cards = states.filter(row => row.petId === input.petId && row.key);
  if (cards.length > 1 && (typeof args.targetText !== 'string' || !args.targetText.trim() || !input.text.includes(args.targetText)
    || cards.filter(row => row.text.includes(args.targetText!)).length !== 1 || !state.text.includes(args.targetText))) {
    throw new Error('有多张记录卡，请明确要修改哪条，例如引用该条正文中的独有内容');
  }
  if (args.dateSources !== undefined && (!Array.isArray(args.dateSources) || args.dateSources.length > 4
    || args.dateSources.some(text => typeof text !== 'string' || !text.trim()))) throw new Error('日期依据必须是最多四段用户原话');
  const patch: DraftUpdate['patch'] = {};
  if (args.date !== undefined) {
    const sources = [{ content: input.text, referenceDate }, ...(input.userHistory || []).slice().reverse()];
    const date = resolveDraftDate(args.sourceText, sources[0], args.dateSources, sources, referenceDate);
    if (!isValidDate(args.date) || !date || date !== args.date || date > referenceDate) throw new Error('更正日期与用户依据不一致或尚不明确，请补充完整日期');
    patch.date = date;
  }
  if (args.text !== undefined) {
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 12000) throw new Error('草稿正文不能为空或超过长度限制');
    patch.text = args.text.trim();
  }
  if (args.tags !== undefined) {
    if (!Array.isArray(args.tags) || args.tags.length > 20 || args.tags.some(tag => typeof tag !== 'string' || tag.length > 30)) throw new Error('草稿标签无效');
    patch.tags = args.tags.slice();
  }
  if (!Object.keys(patch).length) throw new Error('请指定要更正的草稿字段');
  const supplements = (args.dateSources || []).map(text => findSource(text, [{ content: input.text, referenceDate }, ...(input.userHistory || []).slice().reverse()]).content)
    .filter(text => text !== input.text);
  return { key: args.key, expected: { ...state, tags: state.tags?.slice() }, patch,
    correction: [input.originalText ?? input.text, ...Array.from(new Set(supplements)).map(text => `日期补充原话：\n${text}`)].join('\n\n') };
}

export function appendCorrection(original: RawInput | undefined, draft: Draft, correction: string): RawInput {
  const raw = original || { text: draft.text, photos: draft.photos.slice(), provenance: 'legacy' as const };
  const text = `${raw.text}\n\n用户更正原话：\n${correction}`;
  if (text.length > 12000) throw new Error('原始输入与更正依据超过长度限制，请从编辑面板修改');
  return { ...raw, photos: raw.photos.slice(), text };
}

export function draftUpdateReply(state: DraftState, patch: DraftUpdate['patch']): string {
  const fields = [patch.date !== undefined ? `日期改为${state.date}` : '', patch.text !== undefined ? '正文已修改' : '', patch.tags !== undefined ? '标签已修改' : ''].filter(Boolean);
  return `已更新这条待确认草稿：${fields.join('，')}。核对后再保存。`;
}

/** 有限补救：明确纠正日期但模型漏用工具时，避免用无依据的口头确认结束。 */
export function dateCorrectionFallback(text: string, states: DraftState[], petId: string, userHistory: UserSource[] = [], referenceDate = today(), originalText?: string): { update?: DraftUpdate; reply: string } | undefined {
  if (!isDateCorrectionRequest(text) || !states.length) return;
  const pending = states.filter(row => row.petId === petId && row.status === 'pending' && row.key);
  if (pending.length !== 1) return { reply: pending.length ? '有多张待确认草稿，请告诉我要改哪条，并补充正确日期。' : '当前没有可修改的待确认草稿；已保存记录请从时光册编辑。' };
  if (states.filter(row => row.petId === petId && row.key).length > 1) return { reply: '有多张记录卡，请指出要改哪条，并补充正确日期。' };
  const date = resolveDraftDate(text, { content: text, referenceDate }, undefined, [], referenceDate);
  if (date && date <= referenceDate) return { update: validateDraftUpdate({ key: pending[0].key!, sourceText: text, date }, states, { text, originalText, petId, userHistory }, referenceDate), reply: '' };
  return { reply: `这条草稿的实际日期是${pending[0].date || '未确定'}，尚未修改。请补充完整日期，或点卡片的“修改”选择日期。` };
}

export function isDateCorrectionRequest(text: string): boolean {
  return /日期/.test(text) && /不对|错|问题|应该|应当|改成|改为|改到|更正|调整/.test(text);
}

/** 工具与 JSON 共用的写作分工，避免把事实出处误当成正文必须照抄的限制。 */
export const DRAFT_WRITING_GUIDE = `sourceText 是事实出处，必须逐字摘取用户原话；text 是展示给用户的日记正文，允许自然整理、补足语法和去除口头赘词，不必照抄 sourceText。原话已经自然完整时可保留，不为改写而改写。
sourceText 必须保留该事实的完整日期，包括年份。例如「25年10月1日，领养了小猫」不能只摘「10月1日」或「领养了小猫」。
日期分散在多轮用户消息时，用 dateSources 逐字摘取与该事件明确关联的日期补充，例如前文「这是去年拍的」和本轮「12月27号，猫在吃饭」。不得借用另一事件的日期；有多个可能事件时先追问。date 仅是候选值，代码以用户证据校验，无法确定时留空。「今天想补记」是操作时间，不覆盖事件日期。
日期已有独立字段，正文通常省略「今天/昨天」等相对日期，保留「上午/晚上」等具体时段和用户表达的重要细节，方便以后回看。例如用户说「昨晚和点点玩逗猫棒」，sourceText 保留原话，text 可写「晚上和点点玩了逗猫棒」。不能添加未说过的心情、反应、时长或次数，如「玩得很开心」「追逐了一小时」。
tags 使用简短自然的中文展示标签，例如「玩耍」「逗猫棒」，不要把 play、feeding 等工具事件标识直接当作中文日记标签。`;

/**
 * 工具和 JSON 共用：语义由模型判断，这里验证可检查的原文、归属与日期边界。
 * 具体分工：
 * - 是否记录、记录什么 → 由模型调用 create_draft_record 决定（内容含糊时它应该直接追问用户）
 * - 正文 → 用模型整理的结果，原文另存 rawInput，日记详情始终可对照
 * - 日期 → 不用模型给的，从选中的用户事实分句解析；解析不出就待用户点选
 * - 否定/计划等语义 → 模型判断；原文出处、归属、保存时机 → 代码控制
 */
export function validateDraft(args: Record<string, any>, input: { text: string; originalText?: string; petId: string; photos: string[];
  userHistory?: Array<{ content: string; referenceDate?: string }> }, referenceDate = today()) {
  if (!args || typeof args.text !== 'string' || !args.text.trim()) throw new Error('草稿正文不能为空');
  if (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.some((tag: unknown) => typeof tag !== 'string'))) throw new Error('草稿标签无效');
  // 模型选原文证据，代码只验证确实由用户说过；不把助手建议当成用户事实。
  const evidence = args.sourceText === undefined ? input.text : args.sourceText;
  const sources = [{ content: input.text, referenceDate }, ...(input.userHistory || []).slice().reverse()];
  const source = findSource(evidence, sources);
  const date = resolveDraftDate(evidence, source, args.dateSources, sources, referenceDate);
  if (date && date > referenceDate) throw new Error('未来的计划不能记录为已发生事实');
  const tags = Array.isArray(args.tags) && args.tags.length ? (args.tags as string[]) : extractTags(evidence);
  const dateMessages = (args.dateSources || []).map((text: string) => findSource(text, sources).content).filter((text: string) => text !== source.content);
  const rawText = [source.content === input.text ? input.originalText ?? source.content : source.content,
    ...Array.from(new Set(dateMessages)).map(text => `日期补充原话：\n${text}`)].join('\n\n');
  if (rawText.length > 12000) throw new Error('原始输入与日期依据超过长度限制，请分开记录');
  return { petId: input.petId, date, text: args.text.trim(), tags, photos: input.photos.slice(),
    rawInput: { text: rawText, photos: input.photos.slice(), provenance: 'direct' as const } };
}
