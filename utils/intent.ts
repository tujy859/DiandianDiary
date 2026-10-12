/**
 * 【演示应答器】本轮 AI 能力由本地规则模拟，用于验证聊天交互，未接入真实模型。
 * 界面中所有 AI 回复都会带「本地演示」标识，正式版将替换为云端模型调用。
 * 查询类回答只读取已保存记录 + utils/date 的确定性计算，不做任何猜测。
 */
import { getRecords, DiaryRecord } from './store';
import { today, parseDateWords, displayDate, diffDays, relDay } from './date';

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

/** 按标签名或别名查找规则（供真实模型的 queryTag 映射回本地确定性查询） */
export function findRuleByTag(tag: string) {
  if (!tag) return null;
  return TAG_RULES.find((r) => r.tag === tag || r.words.some((w) => tag.indexOf(w) >= 0 || w.indexOf(tag) >= 0)) || null;
}

function recordMatches(rec: DiaryRecord, rule: { tag: string; words: string[] }): boolean {
  if (rec.tags.indexOf(rule.tag) >= 0) return true;
  return rule.words.some((w) => (rec.text || '').indexOf(w) >= 0);
}

function refOf(rec: DiaryRecord) {
  const snippet = rec.text ? `「${rec.text.slice(0, 20)}${rec.text.length > 20 ? '…' : ''}」` : '（照片日记）';
  return {
    recordId: rec.id,
    label: '查看那天的记录',
    sub: `${displayDate(rec.date)} ${snippet}`,
  };
}

const RE_NEG = /没(有)?|没有|不打算/;
const RE_FUTURE = /明天|后天|下周|打算|准备|想要|计划|想给|晚点|回头/;
const RE_QUERY = /上次|最近|什么时候|啥时候|多久|多少天|几次|多少次|第几次/;
const RE_CONSULT = /吗[？?]?$|该不该|要不要|可以.*吗|行吗|好不好/;
const RE_FACT_DONE = /(今天|昨天|前天|刚刚|刚才)[^。？！]*了/;

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
  let matchedRule = rule;
  if (!matchedRule) {
    // 问法把关键词隔开时（如「洗了几次澡」），剥掉疑问词后再匹配一次
    const cleaned = input.text.replace(
      /(上次|最近|这个月|上个月|什么时候|啥时候|多久|多少天|多少次|几次|有没有|的|了|吗|呢|？|\?|，|。|,|\.|\s)/g,
      '',
    );
    matchedRule = matchRule(cleaned);
  }
  if (!matchedRule) {
    return {
      kind: 'text',
      text: `想查哪一类的事呢？比如可以问：「上次什么时候洗澡」「这个月吃了几次罐头」。我只会查已经保存的记录哦。`,
    };
  }
  const matched = getRecords(input.petId).filter((r) => recordMatches(r, matchedRule));
  if (!matched.length) {
    return {
      kind: 'text',
      text: `翻遍了时光册，还没有找到${input.petName}的「${matchedRule.tag}」记录。记一条之后就能查到啦。`,
    };
  }
  const latest = matched[0]; // getRecords 已按日期倒序
  const n = diffDays(latest.date, today());
  const when = n === 0 ? '就是今天' : `${displayDate(latest.date)}，${relDay(latest.date)}`;
  let text = `最近一条「${matchedRule.tag}」记录是${when}。`;
  if (latest.text) text += `\n当时记的是：「${latest.text}」`;
  if (/(几次|多少次|第几次)/.test(input.text)) {
    text = `时光册里一共有 ${matched.length} 条「${matchedRule.tag}」记录。\n` + text;
  }
  return { kind: 'query', text, refs: [refOf(latest)] };
}

/** 咨询类：结合已保存记录给出（演示）建议，不生成记录 */
function answerConsult(input: RespondInput, rule: { tag: string; words: string[] } | null): AiOutput {
  if (rule && rule.tag === '洗澡') {
    const matched = getRecords(input.petId).filter((r) => recordMatches(r, rule));
    if (matched.length) {
      const latest = matched[0];
      return {
        kind: 'query',
        text: `上次洗澡是${displayDate(latest.date)}（${relDay(latest.date)}）。一般来说猫咪不用频繁洗澡，短毛猫两三个月一次即可，可以再结合它最近的状态决定～`,
        refs: [refOf(latest)],
      };
    }
    return { kind: 'text', text: `还没有${input.petName}的洗澡记录可以参考。一般来说猫咪不需要频繁洗澡，别太紧张～` };
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
  const future = RE_FUTURE.test(text);
  const query = RE_QUERY.test(text);
  const consult = !query && RE_CONSULT.test(text);
  const outs: AiOutput[] = [];

  // 事实 + 问题同时出现：分别处理（事实进待确认卡，问题正常回答）
  const factInside = rule && RE_FACT_DONE.test(text) && !neg && !future;

  if (query) {
    if (factInside) outs.push(makeDraft(input, parseDateWords(text)));
    outs.push(answerQuery(input, rule));
    return outs;
  }
  if (consult) {
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
