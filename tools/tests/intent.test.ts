import { respond } from '../../utils/intent';
import { savePet, addRecord, removePet, removeRecord, Pet } from '../../utils/store';
import { today, addDays } from '../../utils/date';

const PET = { id: 'pet-test', name: '咪咪' };
const outs = (text: string, photos: string[] = [], petId = PET.id, petName = PET.name) =>
  respond({ text, photos, petId, petName });
const hasDraft = (res: any[]) => res.some((o) => o.kind === 'draft');
const draftOf = (res: any[]) => res.find((o) => o.kind === 'draft');

describe('用户意图区分（聊天 ≠ 正式记录）', () => {
  test('明确发生的事实 → 出待保存卡，日期与标签正确', () => {
    const res = outs('今天给咪咪洗澡了，洗完一直躲在床底');
    expect(hasDraft(res)).toBe(true);
    const d = draftOf(res).draft;
    expect(d.date).toBe(today());
    expect(d.tags).toContain('洗澡');
    expect(d.text).toContain('洗澡');
  });

  test('咨询：今天该洗澡吗 → 不出卡', () => {
    expect(hasDraft(outs('今天该洗澡吗？'))).toBe(false);
  });

  test('计划：明天想给它洗澡 → 不出卡', () => {
    expect(hasDraft(outs('明天想给它洗澡'))).toBe(false);
  });

  test('否定：今天没有洗澡 → 不出卡', () => {
    expect(hasDraft(outs('今天没有洗澡'))).toBe(false);
  });

  test('查询：上次什么时候洗澡 → 不出卡', () => {
    expect(hasDraft(outs('上次什么时候洗澡？'))).toBe(false);
  });

  test('感叹：咪咪今天好萌 → 不出卡，但保留手动入口', () => {
    const res = outs('咪咪今天好萌');
    expect(hasDraft(res)).toBe(false);
    expect(res.some((o) => o.action === 'draft-from')).toBe(true);
  });

  test('只发照片 → 照片日记，日期待确认且不带文字', () => {
    const res = outs('', ['tmp://a.jpg']);
    const d = draftOf(res).draft;
    expect(d.tags).toContain('照片');
    expect(d.date).toBeNull();
    expect(d.photos.length).toBe(1);
  });

  test('一句话同时含事实与问题 → 分别处理', () => {
    const res = outs('今天给咪咪洗澡了，上次是什么时候洗的？');
    expect(hasDraft(res)).toBe(true);
    expect(res.some((o) => o.kind === 'query' || o.kind === 'text')).toBe(true);
  });
});

describe('查询基于真实记录，结果确定', () => {
  let pet: Pet;
  let r1: any;
  let r2: any;

  beforeEach(() => {
    pet = savePet({ name: '__intent_test__', species: '猫' });
    r1 = addRecord({ petId: pet.id, date: addDays(today(), -10), text: '第一次洗澡', tags: ['洗澡'], photos: [] });
    r2 = addRecord({ petId: pet.id, date: addDays(today(), -3), text: '第二次洗澡', tags: ['洗澡'], photos: [] });
  });

  afterEach(() => {
    removePet(pet.id);
  });

  test('命中真实记录并给出天数与引用', () => {
    const res = outs('上次什么时候洗澡？', [], pet.id, pet.name);
    expect(res[0].text).toContain('3天前');
    expect(res[0].refs && res[0].refs[0].recordId).toBe(r2.id);
  });

  test('关键词被问法隔开时仍能命中（洗了几次澡）', () => {
    const res = outs('洗了几次澡？', [], pet.id, pet.name);
    expect(res[0].text).toContain('2 条');
  });

  test('删除后查询反映变化', () => {
    removeRecord(r2.id);
    const res = outs('上次什么时候洗澡？', [], pet.id, pet.name);
    expect(res[0].text).toContain('10天前');
  });

  test('没查到时明确说没有', () => {
    const res = outs('上次什么时候驱虫？', [], pet.id, pet.name);
    expect(res[0].text).toContain('没有找到');
  });
});
