import { hasYearExpression, parseDateWords, today } from './date';
import { extractTags } from './intent';

/** 工具与 JSON 共用的写作分工，避免把事实出处误当成正文必须照抄的限制。 */
export const DRAFT_WRITING_GUIDE = `sourceText 是事实出处，必须逐字摘取用户原话；text 是展示给用户的日记正文，允许自然整理、补足语法和去除口头赘词，不必照抄 sourceText。原话已经自然完整时可保留，不为改写而改写。
sourceText 必须保留该事实的完整日期，包括年份。例如「25年10月1日，领养了小猫」不能只摘「10月1日」或「领养了小猫」。
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
export function validateDraft(args: Record<string, any>, input: { text: string; petId: string; photos: string[];
  userHistory?: Array<{ content: string; referenceDate?: string }> }, referenceDate = today()) {
  if (!args || typeof args.text !== 'string' || !args.text.trim()) throw new Error('草稿正文不能为空');
  if (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.some((tag: unknown) => typeof tag !== 'string'))) throw new Error('草稿标签无效');
  // 模型选原文证据，代码只验证确实由用户说过；不把助手建议当成用户事实。
  const evidence = args.sourceText === undefined ? input.text : args.sourceText;
  const sources = [{ content: input.text, referenceDate }, ...(input.userHistory || []).slice().reverse()];
  const source = typeof evidence === 'string' && sources.find((row) => row.content.includes(evidence));
  if (!source || !evidence.trim()) {
    throw new Error('请从当前话题的用户原话中选择事实依据，不能使用助手建议或编造原文');
  }
  // 补回紧邻证据之前的日期前缀，避免模型摘句时把「25年」或日期标题截掉。
  // 只接日期字符组成的相邻片段，不从其他事件或其他句子借日期。
  const prefix = source.content.slice(0, source.content.indexOf(evidence));
  const fragment = prefix.match(/(?:今年|去年|前年|明年|后年)(?:的)?(?:\s*\d{1,2}\s*月)?\s*$|[\d零〇○一二三四五六七八九年/月日号.\-\s]+[，,:：]?\s*$/)?.[0] || '';
  const datePrefix = hasYearExpression(fragment) || /月|\d{4}\s*[-/.]/.test(fragment) ? fragment : '';
  const dateEvidence = datePrefix + evidence;
  const parts = dateEvidence.split(/[，,。；;！？!?\n]/);
  const parsed = parts.map((part: string) => parseDateWords(part, source.referenceDate || referenceDate));
  const unresolvedYear = parts.some((part: string, index: number) => hasYearExpression(part) && !parsed[index]);
  const dates = Array.from(new Set(parsed.filter(Boolean)));
  const date = !unresolvedYear && dates.length === 1 ? dates[0] as string : null;
  if (date && date > referenceDate) throw new Error('未来的计划不能记录为已发生事实');
  const tags = Array.isArray(args.tags) && args.tags.length ? (args.tags as string[]) : extractTags(evidence);
  return { petId: input.petId, date, text: args.text.trim(), tags, photos: input.photos.slice(),
    rawInput: { text: source.content, photos: input.photos.slice(), provenance: 'direct' as const } };
}
