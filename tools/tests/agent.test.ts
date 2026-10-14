import { runAgent } from '../../utils/agent';
import { savePet, addRecord, getRecords, removePet, clearAll, Pet } from '../../utils/store';
import { today, addDays } from '../../utils/date';

const CFG = { provider: 'test', baseUrl: 'https://example.test', apiKey: 'k', model: 'm' };

/** 模拟模型的多轮返回：每一轮给一个 assistant message */
function mockModel(turns: any[]) {
  let i = 0;
  (global as any).__wxStub.request = (opts: any) => {
    const message = turns[i++] || { content: '（结束）' };
    opts.success({ statusCode: 200, data: { choices: [{ message }] } });
  };
}

describe('Agent 工具调用', () => {
  let pet: Pet;
  let r2: any;

  beforeEach(() => {
    pet = savePet({ name: '__agent_test__', species: '猫' });
    addRecord({ petId: pet.id, date: addDays(today(), -10), text: '第一次洗澡', tags: ['洗澡'], photos: [] });
    r2 = addRecord({ petId: pet.id, date: addDays(today(), -3), text: '第二次洗澡', tags: ['洗澡'], photos: [] });
  });

  afterEach(() => {
    removePet(pet.id);
    clearAll();
  });

  test('调用 query_records：结果来自真实记录，并带回原记录引用', async () => {
    mockModel([
      { content: '', tool_calls: [{ id: 'c1', function: { name: 'query_records', arguments: JSON.stringify({ keyword: '洗澡', mode: 'latest' }) } }] },
      { content: '上次洗澡是三天前。' },
    ]);
    const res = await runAgent(CFG, '上次什么时候洗澡？', { pet, history: [], photos: [] });
    expect(res.reply).toContain(r2.date);
    expect(res.reply).toContain('3天前');
    expect(res.refs.length).toBe(1);
    expect(res.refs[0].recordId).toBe(r2.id);
    expect(res.drafts.length).toBe(0);
  });

  test('调用 create_draft_record：只生成草稿，绝不静默保存', async () => {
    const before = getRecords(pet.id).length;
    mockModel([
      {
        content: '',
        tool_calls: [
          {
            id: 'c1',
            function: {
              name: 'create_draft_record',
              arguments: JSON.stringify({ date: today(), text: '洗了澡', sourceText: '今天给咪咪洗澡了', tags: ['洗澡'] }),
            },
          },
        ],
      },
      { content: '记下来啦，确认一下～' },
    ]);
    const res = await runAgent(CFG, '今天给咪咪洗澡了', { pet, history: [], photos: ['/tmp/p.jpg'] });
    expect(res.drafts.length).toBe(1);
    expect(res.drafts[0].date).toBe(today());
    expect(res.drafts[0].photos).toEqual(['/tmp/p.jpg']);
    // 关键不变量：未经用户确认，记录数不变
    expect(getRecords(pet.id).length).toBe(before);
  });

  test('没有工具调用时只回复，不产生草稿', async () => {
    mockModel([{ content: '哈哈，它今天真可爱。' }]);
    const res = await runAgent(CFG, '咪咪今天好萌', { pet, history: [], photos: [] });
    expect(res.drafts.length).toBe(0);
    expect(res.refs.length).toBe(0);
    expect(res.reply).toBe('哈哈，它今天真可爱。');
  });

  test('工具执行结果会回灌给模型', async () => {
    const payloads: any[] = [];
    let i = 0;
    (global as any).__wxStub.request = (opts: any) => {
      payloads.push(opts.data);
      const message = i++ === 0
        ? { content: '', tool_calls: [{ id: 'c1', function: { name: 'query_records', arguments: JSON.stringify({ keyword: '洗澡' }) } }] }
        : { content: '好的。' };
      opts.success({ statusCode: 200, data: { choices: [{ message }] } });
    };
    await runAgent(CFG, '上次什么时候洗澡？', { pet, history: [], photos: [] });
    // 第一轮请求带上工具定义
    expect(payloads[0].tools.length).toBeGreaterThan(0);
    // 第二轮请求带上 tool 角色的执行结果
    const second = payloads[1];
    expect(second.messages.some((m: any) => m.role === 'tool')).toBe(true);
    expect(JSON.stringify(second.messages)).toContain('第二次洗澡');
  });
});

describe('是否记录由模型判断，写库必须由用户点确认', () => {
  let pet: Pet;
  beforeEach(() => {
    clearAll();
    pet = savePet({ name: '咪咪', species: '猫' });
  });
  afterEach(() => clearAll());
  const tool = (name: string, args: any) => ({ content: '', tool_calls: [{ id: 'c1', function: { name, arguments: JSON.stringify(args) } }] });
  test.each(['今天该不该驱虫？', '明天给咪咪驱虫', '咪咪今天好萌', '上次什么时候驱虫？'])('模型对 %s 编造事实出处时拒绝出卡', async (text) => {
    mockModel([tool('create_draft_record', { text: '已经驱虫', sourceText: '今天已经驱虫', tags: ['医疗'] }), { content: '请补充实际发生的事情' }]);
    const result = await runAgent(CFG, text, { pet, history: [], photos: [] });
    expect(result.drafts).toHaveLength(0);
    expect(getRecords(pet.id)).toHaveLength(0); // 用户没确认就不写库
  });
  test('不能删除原话的否定词后冒充原文出处', async () => {
    mockModel([tool('create_draft_record', { text: '已经驱虫', sourceText: '今天驱虫', tags: ['医疗'] }), { content: '好的' }]);
    const result = await runAgent(CFG, '今天没有驱虫', { pet, history: [], photos: [] });
    expect(result.drafts).toHaveLength(0);
  });
  test('混合句子里否定的部分不算，记的是后来发生的那件', async () => {
    mockModel([tool('create_draft_record', { date: today(), text: '洗了澡', sourceText: '今天洗了澡' }), { content: '好了' }]);
    const result = await runAgent(CFG, '昨天没洗澡，今天洗了澡', { pet, history: [], photos: [] });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].text).toBe('洗了澡');
    expect(result.drafts[0].date).toBe(today());
  });
  test('日期只信用户原话的解析，模型给的日期一律不作数', async () => {
    mockModel([tool('create_draft_record', { date: '2026-99-99', text: '驱虫', sourceText: '今天驱虫了' }), { content: '好了' }]);
    const invalidDate = await runAgent(CFG, '今天驱虫了', { pet, history: [], photos: [] });
    expect(invalidDate.drafts).toHaveLength(1);
    expect(invalidDate.drafts[0].date).toBe(today());
    mockModel([tool('create_draft_record', { date: today(), text: '洗澡', sourceText: '上周左右洗澡了' }), { content: '好了' }]);
    const result = await runAgent(CFG, '上周左右洗澡了', { pet, history: [], photos: [] });
    expect(result.drafts[0].date).toBeNull(); // 用户没说清日期，交给用户点选
    expect(result.drafts[0].text).toBe('洗澡');
  });
  test('宠物归属由代码决定，模型说什么都不算', async () => {
    mockModel([tool('create_draft_record', { date: today(), text: '已经驱虫', sourceText: '今天驱虫了' }), { content: '好了' }]);
    const result = await runAgent(CFG, '今天驱虫了', { pet, history: [], photos: [] });
    expect(result.drafts[0].petId).toBe(pet.id);
  });
});

describe('查询场景：事实来自本地工具，不受模型说法影响', () => {
  let pet: Pet;
  beforeEach(() => {
    clearAll();
    pet = savePet({ name: '咪咪', species: '猫' });
  });
  afterEach(() => clearAll());
  const tool = (name: string, args: any) => ({ content: '', tool_calls: [{ id: 'c1', function: { name, arguments: JSON.stringify(args) } }] });
  test('模型的错误日期/条数不能覆盖查询结果', async () => {
    const record = addRecord({ petId: pet.id, date: addDays(today(), -3), text: '驱虫', tags: ['医疗'], photos: [] });
    mockModel([tool('query_records', { keyword: '驱虫' }), { content: '2020-01-01驱虫了99次' }]);
    const result = await runAgent(CFG, '上次什么时候驱虫', { pet, history: [], photos: [] });
    expect(result.reply).toContain(record.date);
    expect(result.reply).toContain('共 1 条');
    expect(result.reply).not.toContain('99次');
  });
  test('模型漏用工具也不能把空结果编成已有记录', async () => {
    mockModel([{ content: '昨天驱虫了。' }]);
    const result = await runAgent(CFG, '上次什么时候驱虫', { pet, history: [], photos: [] });
    expect(result.reply).toContain('没有找到');
    expect(result.reply).not.toContain('昨天');
  });
  test('咨询时保留模型建议，同时展示本地事实与引用', async () => {
    const record = addRecord({ petId: pet.id, date: addDays(today(), -3), text: '洗澡', tags: ['洗澡'], photos: [] });
    mockModel([tool('query_records', { eventType: 'bath', purpose: 'context' }), { content: '先说说它当前的身体状态好吗？' }]);
    const result = await runAgent(CFG, '今天该不该洗澡？', { pet, history: [], photos: [] });
    expect(result.reply).toContain('身体状态');
    expect(result.refs[0].recordId).toBe(record.id);
    expect(result.drafts).toHaveLength(0);
  });

  test('省略主语的追问交给模型参数，不被本句关键词拦截', async () => {
    const record = addRecord({ petId: pet.id, date: today(), text: '打疫苗', tags: ['疫苗'], photos: [] });
    mockModel([tool('query_records', { eventType: 'vaccination', mode: 'latest' }), { content: '查到了' }]);
    const result = await runAgent(CFG, '那疫苗呢？', { pet, history: [{ role: 'user', content: '上次驱虫什么时候' }], photos: [] });
    expect(result.refs.map((r) => r.recordId)).toEqual([record.id]);
  });

  test('一个输入查两个事件，参数不会被原话中的第一个事件覆盖', async () => {
    addRecord({ petId: pet.id, date: today(), text: '驱虫', tags: [], photos: [] });
    addRecord({ petId: pet.id, date: today(), text: '打疫苗', tags: [], photos: [] });
    mockModel([{ content: '', tool_calls: [
      { id: 'q1', function: { name: 'query_records', arguments: '{"eventType":"deworming"}' } },
      { id: 'q2', function: { name: 'query_records', arguments: '{"eventType":"vaccination"}' } },
    ] }, { content: '查到了' }]);
    const result = await runAgent(CFG, '上次驱虫和疫苗分别是什么时候', { pet, history: [], photos: [] });
    expect(result.reply).toContain('「驱虫」');
    expect(result.reply).toContain('「疫苗」');
    expect(result.refs).toHaveLength(2);
  });

  test('工具参数错误后可修正，不把旧错误当成最终事实', async () => {
    mockModel([tool('query_records', { limit: -1 }), tool('query_records', { limit: 1 }), { content: '查到了' }]);
    const result = await runAgent(CFG, '查一下记录', { pet, history: [], photos: [] });
    expect(result.reply).toContain('没有找到');
    expect(result.reply).not.toContain('返回条数');
  });

  test('读历史话题只回给模型，咨询回复不会暴露整段原文或触发错误查询兜底', async () => {
    const readSession = jest.fn().mockResolvedValue('用户：私密旧事\n助手：旧建议');
    mockModel([tool('read_session', { id: 'old' }), { content: '之前讨论过吹干方法' }]);
    const result = await runAgent(CFG, '上次我们讨论的那个建议呢？', { pet, history: [], photos: [],
      sessionIndex: [{ id: 'old', title: '吹干' }], readSession });
    expect(result.reply).toBe('之前讨论过吹干方法');
    expect(result.reply).not.toContain('私密旧事');
    expect(readSession).toHaveBeenCalledWith('old', 0, 20);
  });

  test('循环到上限后仍有一次无工具收尾，不静默结束', async () => {
    mockModel([...Array.from({ length: 6 }, () => tool('read_conversation', {})), { content: '还需要你明确想找的事情' }]);
    const result = await runAgent(CFG, '帮我找找前面说的', { pet, history: [], photos: [] });
    expect(result.toolsUsed).toHaveLength(6);
    expect(result.reply).toContain('明确');
  });
});

describe('从用户证据生成草稿', () => {
  const tool = (args: any) => ({ content: '', tool_calls: [{ id: 'draft', function: { name: 'create_draft_record', arguments: JSON.stringify(args) } }] });
  let pet: Pet;
  beforeEach(() => { clearAll(); pet = savePet({ name: '点点', species: '猫' }); });
  afterEach(() => clearAll());

  test('把刚才的记下来：保留前文事实原文与日期，不保存确认指令', async () => {
    mockModel([tool({ text: '洗了澡', sourceText: '昨天给点点洗了澡' }), { content: '整理好了' }]);
    const result = await runAgent(CFG, '把刚才的记下来', { pet, photos: [],
      history: [{ role: 'user', content: '昨天给点点洗了澡，没想到这么乖' }] });
    expect(result.drafts[0].date).toBe(addDays(today(), -1));
    expect(result.drafts[0].rawInput!.text).toBe('昨天给点点洗了澡，没想到这么乖');
    expect(getRecords(pet.id)).toHaveLength(0);
  });

  test('助手说过的建议不能作为记录依据', async () => {
    mockModel([tool({ text: '驱虫了', sourceText: '今天驱虫了' }), { content: '请说明发生了什么' }]);
    const result = await runAgent(CFG, '记一下', { pet, photos: [], history: [{ role: 'assistant', content: '今天驱虫了' }] });
    expect(result.drafts).toHaveLength(0);
  });

  test('没想到、没有不良反应等词不能拦截实际发生的事', async () => {
    const text = '没想到今天驱虫这么顺利，没有不良反应';
    mockModel([tool({ text: '驱虫顺利，无不良反应', sourceText: text }), { content: '整理好了' }]);
    const result = await runAgent(CFG, text, { pet, photos: [], history: [] });
    expect(result.drafts).toHaveLength(1);
  });

  test('重新打开旧话题后，相对日期按原消息日期解析', async () => {
    mockModel([tool({ text: '洗了澡', sourceText: '昨天洗了澡' }), { content: '整理好了' }]);
    const result = await runAgent(CFG, '把刚才的记下来', { pet, photos: [], history: [],
      conversation: [{ role: 'user', content: '昨天洗了澡', referenceDate: '2020-05-10' }] });
    expect(result.drafts[0].date).toBe('2020-05-09');
  });

  test('早于上下文预算的内容仍可由工具读取并用作事实出处', async () => {
    const first = '2020年5月9日收养了点点';
    mockModel([{ content: '', tool_calls: [{ id: 'read', function: { name: 'read_conversation', arguments: '{"offset":0,"limit":1}' } }] },
      tool({ text: '收养了点点', sourceText: first }), { content: '整理好了' }]);
    const result = await runAgent(CFG, '把最开始说的收养经历记下来', { pet, photos: [], history: [],
      conversation: [{ role: 'user', content: first }, ...Array.from({ length: 30 }, () => ({ role: 'user' as const, content: '闲聊' }))] });
    expect(result.toolsUsed).toEqual(['read_conversation', 'create_draft_record']);
    expect(result.drafts[0].date).toBe('2020-05-09');
  });
});
