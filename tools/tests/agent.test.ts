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
    expect(res.reply).toBe('上次洗澡是三天前。');
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
