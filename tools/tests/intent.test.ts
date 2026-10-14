import { sourceForDraft, extractTags } from '../../utils/intent';

describe('事实分句：只有用户原话中已发生的部分能进日记', () => {
  test('陈述事实 → 取出事实分句', () => {
    expect(sourceForDraft('今天给咪咪洗澡了，洗完一直躲在床底')).toContain('洗澡');
  });

  test('咨询不是事实', () => {
    expect(sourceForDraft('今天该洗澡吗？')).toBeNull();
  });

  test('计划不是事实', () => {
    expect(sourceForDraft('明天想给它洗澡')).toBeNull();
  });

  test.each(['下个月给咪咪驱虫', '今天尚未驱虫', '明年打疫苗'])('%s 不是事实', (text) => {
    expect(sourceForDraft(text)).toBeNull();
  });

  test('否定不是事实', () => {
    expect(sourceForDraft('今天没有洗澡')).toBeNull();
  });

  test('查询不是事实', () => {
    expect(sourceForDraft('上次什么时候洗澡？')).toBeNull();
  });

  test('一句话同时含事实与问题 → 只留事实', () => {
    const source = sourceForDraft('今天给咪咪洗澡了，上次是什么时候洗的？')!;
    expect(source).toContain('洗澡');
    expect(source).not.toContain('上次');
  });

  test('感叹没有可确认的事实', () => {
    expect(sourceForDraft('咪咪今天好萌')).toBeNull();
  });

  test('「带…去了这里」这类动作句是事实（配图场景）', () => {
    expect(sourceForDraft('记一下，我10月5号带点点去了这里')).toBe('我10月5号带点点去了这里');
  });

  test('「买了/换了」这类日常动作是事实', () => {
    expect(sourceForDraft('记一下，今天给它买了新玩具')).toContain('买了新玩具');
    expect(sourceForDraft('给它换了新猫粮')).toContain('换了新猫粮');
  });

  test('「记一下」指令本身不进正文', () => {
    const source = sourceForDraft('记一下，今天给咪咪洗澡了')!;
    expect(source).not.toContain('记一下');
  });
});

describe('标签抽取', () => {
  test('命中词表', () => {
    expect(extractTags('今天给咪咪洗澡了')).toContain('洗澡');
    expect(extractTags('喂了罐头')).toContain('喂食');
  });

  test('不相关文本不出标签', () => {
    expect(extractTags('今天天气不错')).toEqual([]);
  });
});
