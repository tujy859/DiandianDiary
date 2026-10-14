/**
 * 确定性文本加工：标签抽取与事实分句。
 * 意图判断已交给模型（utils/agent.ts），这里只保留不依赖模型的确定性能力，
 * 供草稿校验器（utils/draft.ts）和日记整理使用。
 */
/** 标签词表：顺序即优先级 */
const TAG_RULES: Array<{ tag: string; words: string[] }> = [
  { tag: '洗澡', words: ['洗澡', '洗护', '沐浴露'] },
  { tag: '喂食', words: ['罐头', '猫粮', '狗粮', '冻干', '零食', '加餐', '喂了', '喂', '吃饭', '吃了'] },
  { tag: '医疗', words: ['疫苗', '体检', '看病', '吃药', '驱虫', '医院', '绝育', '呕吐', '拉稀', '生病'] },
  { tag: '体重', words: ['体重', '称重', '上秤'] },
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

const RE_NEG = /没(有)?|未|不曾|不打算/;
const RE_FUTURE = /明天|后天|下周|下个月|下月|明年|下次|将要|将会|打算|准备|想要|计划|想给|晚点|回头/;
const RE_QUERY = /上次|什么时候|啥时候|多久|多少天|几次|多少次|第几次/;
const RE_CONSULT = /吗[？?]?$|该不该|要不要|可以.*吗|行吗|好不好|怎么办|如何|建议/;

/** 常见「动作+了」：句中没有标签词时靠它识别事实分句（带…去了这里 / 买了玩具 / 换了粮） */
const RE_FACT_VERB = /去了|到了|来到|回来了|路过|打卡|逛了|带了|买了|换了|捡了|收养|领养|打了|做了|学会|学会?了|第一次/;

/** 保留用户原话中的事实分句，问题、计划、否定不能混入草稿正文。 */
export function sourceForDraft(text: string): string | null {
  const parts = text.match(/[^，,。；;！？!?\n]+[！？!?]?/g) || [];
  const facts = parts.map((p) => p.trim()).filter((p) => {
    if (RE_NEG.test(p) || RE_FUTURE.test(p) || RE_QUERY.test(p) || RE_CONSULT.test(p) || /[？?]/.test(p)) return false;
    return !!matchRule(p) || RE_FACT_VERB.test(p) || /了$|了。|过了|完|体重大?约?是?\s*\d|精神|食欲/.test(p);
  });
  return facts.length ? facts.join('，') : null;
}
