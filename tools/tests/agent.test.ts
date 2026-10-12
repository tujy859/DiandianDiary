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
      { content: '', tool_calls: [{ id: 'c1', function: { name: 'query_records', arguments: JSON.stringify({ keyword: '洗澡' }) } }] },
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
              arguments: JSON.stringify({ date: today(), text: '洗了澡，躲在床底', tags: ['洗澡'] }),
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

describe('模型误判保护', () => {
  let pet: Pet;
  beforeEach(() => {
    clearAll();
    pet = savePet({ name: '咪咪', species: '猫' });
  });
  afterEach(() => clearAll());
  const tool = (name: string, args: any) => ({ content: '', tool_calls: [{ id: 'c1', function: { name, arguments: JSON.stringify(args) } }] });
  test.each(['今天该不该驱虫？', '今天没有驱虫', '明天给咪咪驱虫', '咪咪今天好萌', '上次什么时候驱虫？'])('模型对 %s 错调草稿工具也不出卡', async (text) => {
    mockModel([tool('create_draft_record', { date: today(), text: '已经驱虫', tags: ['医疗'] }), { content: '记好了' }]);
    const result = await runAgent(CFG, text, { pet, history: [], photos: [] });
    expect(result.drafts).toHaveLength(0);
    expect(result.reply).not.toContain('记好了');
    expect(getRecords(pet.id)).toHaveLength(0);
  });
  test('拒绝非法日期，不接受模型补出的日期或改写事实', async () => {
    mockModel([tool('create_draft_record', { date: '2026-99-99', text: '驱虫' }), { content: '好了' }]);
    expect((await runAgent(CFG, '今天驱虫了', { pet, history: [], photos: [] })).drafts).toHaveLength(0);
    mockModel([tool('create_draft_record', { date: today(), text: '洗澡五次' }), { content: '好了' }]);
    const result = await runAgent(CFG, '上周左右洗澡了', { pet, history: [], photos: [] });
    expect(result.drafts[0].date).toBeNull();
    expect(result.drafts[0].text).toBe('上周左右洗澡了');
  });
  test('混合事实和查询仅提取事实分句', async () => {
    mockModel([tool('create_draft_record', { date: today(), text: '今天洗澡了，上次什么时候洗的？' }), { content: '好了' }]);
    const result = await runAgent(CFG, '今天洗澡了，上次什么时候洗的？', { pet, history: [], photos: [] });
    expect(result.drafts[0].text).toBe('今天洗澡了');
  });
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
    mockModel([tool('query_records', { eventType: 'bath' }), { content: '先说说它当前的身体状态好吗？' }]);
    const result = await runAgent(CFG, '今天该不该洗澡？', { pet, history: [], photos: [] });
    expect(result.reply).toContain('身体状态');
    expect(result.refs[0].recordId).toBe(record.id);
    expect(result.drafts).toHaveLength(0);
  });
});
