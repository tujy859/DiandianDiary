import { isValidDate, parseDateWords, today } from './date';
import { extractTags, sourceForDraft } from './intent';

/** 工具和 JSON 共用：模型不能创造事实、日期、宠物归属或自动保存。 */
export function validateDraft(args: Record<string, any>, input: { text: string; petId: string; photos: string[] }, referenceDate = today()) {
  if (!args || typeof args.text !== 'string' || !args.text.trim()) throw new Error('草稿正文不能为空');
  if (args.date !== undefined && args.date !== null && args.date !== '' && !isValidDate(args.date)) throw new Error('草稿日期无效');
  if (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.some((tag: unknown) => typeof tag !== 'string'))) throw new Error('草稿标签无效');
  const source = sourceForDraft(input.text);
  if (!source) throw new Error('这条消息没有可确认的已发生事实，不生成记录卡');
  const date = parseDateWords(source, referenceDate);
  if (date && date > referenceDate) throw new Error('未来的计划不能记录为已发生事实');
  if (args.date && date && args.date !== date) throw new Error('草稿日期与用户原话不一致');
  // 日期模糊时保持待确认；原文优先，避免模型改写药名、剂量或其他事实。
  return { petId: input.petId, date, text: source, tags: extractTags(source), photos: input.photos.slice() };
}
