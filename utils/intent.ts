/**
 * 【演示应答器】未配置模型或模型调用失败时使用，本模块输出标记为「本地演示」。
 * 查询类回答只读取已保存记录 + utils/date 的确定性计算，不做任何猜测。
 */
import { parseDateWords, relDay, today } from './date';
import { isHistoryQuery, queryRecords, resolveQueryOptions } from './query';

export interface RespondInput {
  text: string;
  photos: string[];
  petId: string;
  petName: string;
}

export interface AiOutput {
  kind: 'text' | 'draft' | 'query';
  text?: string;
  draft?: { petId: string; date: string | null; text: string; tags: string[]; photos: string[] };
  refs?: { recordId: string; label: string; sub: string }[];
  action?: 'draft-from';
  sourceText?: string;
}

/** 标签词表：顺序即优先级 */
const TAG_RULES: Array<{ tag: string; words: string[] }> = [
  { tag: '洗澡', words: ['洗澡', '洗护', '沐浴露'] },
  { tag: '喂食', words: ['罐头', '猫粮', '狗粮', '冻干', '零食', '加餐', '喂了', '喂', '吃饭', '吃了'] },
  { tag: '医疗', words: ['疫苗', '体检', '看病', '吃药', '驱虫', '医院', '绝育', '呕吐', '拉稀', '生病'] },
  { tag: '清洁', words: ['剪指甲', '梳毛', '刷牙', '洗耳朵', '剃毛'] },
  { tag: '玩耍', words: ['逗猫', '玩耍', '玩了'] },
  { tag: '外出', words: ['遛', '散步', '出门', '下楼'] },
  { tag: '排泄', words: ['便便', '尿了', '拉屎', '猫砂'] },
  { tag: '睡眠', words: ['睡着了', '睡觉'] },
];

export function extractTags(text: string): string[] {
  const tags: string[] = [];
  TAG_RULES.forEach((r) => {
    if (r.words.some((w) => text.indexOf(w) >= 0)) tags.push(r.tag);
  });
  return tags;
}

function matchRule(text: string) {
  return TAG_RULES.find((r) => r.words.some((w) => text.indexOf(w) >= 0)) || null;
}

/** 展示分类的兼容映射；具体事实检索使用 query.ts，不以此扩大检索范围。 */
export function findRuleByTag(tag: string) {
  if (!tag) return null;
  return TAG_RULES.find((r) => r.tag === tag || r.words.some((w) => tag.indexOf(w) >= 0 || w.indexOf(tag) >= 0)) || null;
}

const RE_NEG = /没(有)?|未|不曾|不打算/;
const RE_FUTURE = /明天|后天|下周|下个月|下月|明年|下次|将要|将会|打算|准备|想要|计划|想给|晚点|回头/;
const RE_QUERY = /上次|什么时候|啥时候|多久|多少天|几次|多少次|第几次/;
const RE_CONSULT = /吗[？?]?$|该不该|要不要|可以.*吗|行吗|好不好|怎么办|如何|建议/;
const RE_FACT_DONE = /(今天|昨天|前天|刚刚|刚才)[^。？！]*了/;

/** 保留用户原话中的事实分句，问题、计划、否定不能混入草稿正文。 */
export function sourceForDraft(text: string): string | null {
  const parts = text.match(/[^，,。；;！？!?\n]+[！？!?]?/g) || [];
  const facts = parts.map((p) => p.trim()).filter((p) => {
    if (RE_NEG.test(p) || RE_FUTURE.test(p) || RE_QUERY.test(p) || RE_CONSULT.test(p) || /[？?]/.test(p)) return false;
    return !!matchRule(p) || /了$|了。|过了|完|体重\s*\d|精神|食欲/.test(p);
  });
  return facts.length ? facts.join('，') : null;
}

function makeDraft(input: RespondInput, date: string | null): AiOutput {
  return {
    kind: 'draft',
    draft: {
      petId: input.petId,
      date,
      text: input.text.trim(),
      tags: extractTags(input.text),
      photos: input.photos.slice(),
    },
  };
}

/** 查询已保存记录（确定性，不猜测） */
export function answerQuery(input: RespondInput, rule: { tag: string; words: string[] } | null): AiOutput {
  try {
    // rule 只作为旧调用兼容参数；不能用宽泛的「医疗」替代原话中的「驱虫」。
    const options = resolveQueryOptions(input.text);
    if (!options.eventType && !options.keyword && !/记录|日记/.test(input.text)) {
      return { kind: 'text', text: '想查哪类事情？比如「上次什么时候驱虫」「这个月洗了几次澡」。' };
    }
    const result = queryRecords({ ...options, petId: input.petId });
    return { kind: 'query', text: result.summary, refs: result.refs };
  } catch (error: any) {
    return { kind: 'text', text: error.message };
  }
}

/** 咨询类：结合已保存记录给出（演示）建议，不生成记录 */
function answerConsult(input: RespondInput, rule: { tag: string; words: string[] } | null): AiOutput {
  if (rule && rule.tag === '洗澡') {
    const result = queryRecords({ petId: input.petId, eventType: 'bath', mode: 'latest' });
    if (result.records.length) {
      const latest = result.records[0];
      return {
        kind: 'query',
        text: `最近一条洗澡记录是${latest.date}（${relDay(latest.date)}）。仅凭记录不能判断今天是否适合洗澡，还需要结合物种、年龄、皮肤和当前身体状态。`,
        refs: result.refs,
      };
    }
    return { kind: 'text', text: `还没有${input.petName}的洗澡记录可以参考，仅凭这些信息还不能判断今天是否适合洗澡。` };
  }
  if (rule) {
    return {
      kind: 'text',
      text: `这个问题我没有足够的信息回答（演示版暂不接真实模型）。正式版会结合${input.petName}的历史记录来给出建议。相关的过往记录可以在「时光册」里查看。`,
    };
  }
  return {
    kind: 'text',
    text: `这个问题我记下了（演示版由本地规则应答，暂未接入真实模型）。如果刚才说的是一件已经发生的事，我也可以帮你记下来。`,
  };
}

export function respond(input: RespondInput): AiOutput[] {
  const text = (input.text || '').trim();
  const hasPhotos = input.photos.length > 0;

  // 只发照片：生成不带文字的照片日记预览（日期由用户确认，不猜测内容）
  if (!text && hasPhotos) {
    const d = makeDraft(input, null);
    d.draft!.tags = ['照片'];
    return [
      { kind: 'text', text: '收到照片啦～我整理成了一条照片日记，确认一下发生日期就可以保存。' },
      d,
    ];
  }
  if (!text) return [];

  const rule = matchRule(text);
  const neg = RE_NEG.test(text);
  const date = parseDateWords(text);
  const future = RE_FUTURE.test(text) || !!(date && date > today());
  const query = RE_QUERY.test(text) || isHistoryQuery(text);
  const consult = !query && RE_CONSULT.test(text);
  const outs: AiOutput[] = [];

  // 事实 + 问题同时出现：分别处理（事实进待确认卡，问题正常回答）
  const factSource = sourceForDraft(text);
  const factInside = !!factSource && RE_FACT_DONE.test(factSource);

  if (query) {
    if (factInside) outs.push(makeDraft({ ...input, text: factSource! }, parseDateWords(factSource!)));
    outs.push(answerQuery(input, rule));
    return outs;
  }
  if (consult) {
    if (factInside) outs.push(makeDraft({ ...input, text: factSource! }, parseDateWords(factSource!)));
    outs.push(answerConsult(input, rule));
    return outs;
  }
  if (neg) {
    return [
      {
        kind: 'text',
        text: `明白，那这件事就不记啦。等${input.petName}有值得记一下的时刻再告诉我～`,
      },
    ];
  }
  if (future) {
    return [
      {
        kind: 'text',
        text: `好的，这还是个计划，我先不记。等做完之后告诉我，我再帮你记一下～`,
      },
    ];
  }

  // 明确发生过的事：生成待保存卡片
  if (rule || /了$|了。|过了|完/.test(text)) {
    const date = parseDateWords(text);
    if (date) {
      return [makeDraft(input, date)];
    }
    // 日期不明确：生成卡片但不猜日期，由用户在卡片上点选
    return [
      {
        kind: 'text',
        text: '想帮你记下来～不过没听出来是哪一天发生的，在下面的卡片上点一下日期吧。',
      },
      makeDraft(input, null),
    ];
  }

  if (hasPhotos) {
    const d = makeDraft(input, null);
    if (!d.draft!.tags.length) d.draft!.tags = ['照片'];
    return [d];
  }

  // 感叹 / 闲聊：自然回应，不主动弹记录卡，但保留手动“记一下”
  return [
    {
      kind: 'text',
      text: `哈哈，感受到你对${input.petName}的爱了。想把这个时刻留下来的话，点下面的「记一下」，我帮你整理成日记。`,
      action: 'draft-from',
      sourceText: text,
    },
  ];
}
