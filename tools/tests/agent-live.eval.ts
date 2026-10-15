/** 显式运行 npm run eval:agent；不会进入默认单测/CI，也不会读取个人日记或小程序密钥。 */
import { AgentResult, runAgent } from '../../utils/agent';
import { savePet, addRecord, getRecords, clearAll, Pet } from '../../utils/store';
import { today, addDays } from '../../utils/date';
import { ConversationLine } from '../../utils/context';
import { diaryFlowSteps } from '../../utils/flow-scenarios';

jest.setTimeout(330000);
const cfg = { provider: 'eval', baseUrl: process.env.DIARY_EVAL_BASE_URL || '',
  apiKey: process.env.DIARY_EVAL_API_KEY || '', model: process.env.DIARY_EVAL_MODEL || '' };
let pet: Pet;
let wormId: string;
let vaccineId: string;

beforeAll(() => {
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) throw new Error('请设置 DIARY_EVAL_BASE_URL、DIARY_EVAL_API_KEY、DIARY_EVAL_MODEL；此命令会发起真实模型请求并产生费用。');
  // 复用正式 HTTP 协议，只把微信网络 API 适配到 Node；不引入另一套 agent。
  (wx as any).request = (opts: any) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 45000);
    fetch(opts.url, { method: opts.method, headers: opts.header, body: JSON.stringify(opts.data), signal: controller.signal })
      .then(async (res) => {
        const data = res.ok ? await res.json() : { error: { message: `HTTP ${res.status}` } };
        opts.success({ statusCode: res.status, data });
      }).catch(() => opts.fail({ errMsg: '模型请求失败，请检查连接配置' }))
      .finally(() => clearTimeout(timer));
    return { abort: () => controller.abort() };
  };
});

beforeEach(() => {
  clearAll();
  pet = savePet({ name: '点点', species: '猫' });
  addRecord({ petId: pet.id, date: addDays(today(), -3), text: '给点点洗了澡，吹干了', tags: ['洗澡'], photos: [] });
  wormId = addRecord({ petId: pet.id, date: addDays(today(), -10), text: '做了驱虫', tags: ['医疗'], photos: [] }).id;
  vaccineId = addRecord({ petId: pet.id, date: addDays(today(), -2), text: '接种疫苗', tags: ['医疗'], photos: [] }).id;
  addRecord({ petId: pet.id, date: diaryFlowSteps(today())[0].date!, text: '领养了点点', tags: ['领养'], photos: [] });
});

type Case = { name: string; text: string; history?: ConversationLine[]; conversation?: ConversationLine[];
  check: (r: AgentResult) => void };
const cases: Case[] = [
  ...diaryFlowSteps(today()).filter(s => s.kind === 'record').map(step => ({ name: `端侧共用样例：${step.title}`, text: step.text, check: (r: AgentResult) => {
    expect(r.drafts).toHaveLength(1); expect(r.drafts[0].date).toBe(step.date);
    expect(r.reply).toBe(''); expect(r.refs).toEqual([]);
  } })),
  { name: '新话题领养查询只有对应引用', text: diaryFlowSteps(today())[6].text, history: [], check: (r) => {
    expect(r.drafts).toHaveLength(0); expect(r.refs).toHaveLength(1); expect(r.reply).toContain(diaryFlowSteps(today())[0].date!);
  } },
  { name: '自然陈述产生待确认草稿', text: '今天给点点剪了指甲', check: (r) => {
    expect(r.drafts).toHaveLength(1); expect(r.drafts[0].date).toBe(today()); expect(r.drafts[0].text).toContain('指甲');
  } },
  { name: '日记整理正文与原文出处分开，使用中文标签', text: '昨晚和点点玩逗猫棒', check: (r) => {
    expect(r.drafts).toHaveLength(1);
    const draft = r.drafts[0];
    expect(draft.date).toBe(addDays(today(), -1));
    expect(draft.rawInput!.text).toBe('昨晚和点点玩逗猫棒');
    expect(draft.text).toContain('逗猫棒');
    expect(draft.text).toMatch(/晚|夜/);
    expect(draft.text).not.toContain('昨晚');
    expect(draft.tags).not.toContain('play');
  } },
  { name: '否定不是已完成事件', text: '今天没有给点点驱虫', check: (r) => expect(r.drafts).toHaveLength(0) },
  { name: '明天计划不记录为已发生', text: '明天准备给点点洗澡', check: (r) => expect(r.drafts).toHaveLength(0) },
  { name: '咨询不冒充事实', text: '今天该不该给点点驱虫？', check: (r) => expect(r.drafts).toHaveLength(0) },
  { name: '否定词不误伤已发生事实', text: '没想到今天驱虫这么顺利，没有不良反应', check: (r) => expect(r.drafts).toHaveLength(1) },
  { name: '混合日期选择事实所在分句', text: '昨天没洗澡，今天给点点洗了澡', check: (r) => {
    expect(r.drafts).toHaveLength(1); expect(r.drafts[0].date).toBe(today());
  } },
  { name: '跨轮记一下引用用户事实', text: '把刚才的记下来', history: [{ role: 'user', content: '昨天给点点洗了澡，它很乖' }], check: (r) => {
    expect(r.drafts).toHaveLength(1); expect(r.drafts[0].date).toBe(addDays(today(), -1)); expect(r.drafts[0].rawInput!.text).toContain('昨天给点点洗了澡');
  } },
  { name: '没有事实的记一下应追问', text: '记一下', check: (r) => { expect(r.drafts).toHaveLength(0); expect(r.reply.length).toBeGreaterThan(0); } },
  { name: '助手建议不能变成用户事实', text: '把刚才的记下来', history: [{ role: 'user', content: '我还没决定要不要洗澡' },
    { role: 'assistant', content: '如果要洗澡，记得吹干' }], check: (r) => expect(r.drafts).toHaveLength(0) },
  { name: '驱虫与疫苗分别查询', text: '上次驱虫和疫苗分别是什么时候？', check: (r) => {
    expect(r.refs.map((ref) => ref.recordId)).toEqual(expect.arrayContaining([wormId, vaccineId]));
  } },
  { name: '无关键词追问依靠上下文', text: '那疫苗呢？', history: [{ role: 'user', content: '上次驱虫什么时候？' }], check: (r) => {
    expect(r.refs.map((ref) => ref.recordId)).toContain(vaccineId);
  } },
  { name: '明确回顾需要读取真实日记', text: '根据时光册里已有的日记，回顾一下点点最近的状态', check: (r) => {
    expect(r.toolsUsed).toContain('query_records'); expect(r.refs.length).toBeGreaterThan(0);
  } },
  { name: '超出上下文的早期事实可按需读回', text: '把这个话题最开始说的收养经历记下来', history: [],
    conversation: [{ role: 'user', content: '2020年5月9日收养了点点' }, ...Array.from({ length: 30 }, () => ({ role: 'user' as const, content: '聊了些日常琐事' }))],
    check: (r) => { expect(r.toolsUsed).toContain('read_conversation'); expect(r.drafts).toHaveLength(1); expect(r.drafts[0].date).toBe('2020-05-09'); } },
];

test.each(cases)('$name', async (c) => {
  const started = Date.now();
  const count = getRecords(pet.id).length;
  const result = await runAgent(cfg, c.text, { pet, history: c.history || [], conversation: c.conversation || c.history, photos: [] });
  console.info(JSON.stringify({ case: c.name, model: cfg.model, elapsedMs: Date.now() - started, tools: result.toolsUsed, drafts: result.drafts.length, refs: result.refs.length }));
  expect(getRecords(pet.id)).toHaveLength(count);
  c.check(result);
});
