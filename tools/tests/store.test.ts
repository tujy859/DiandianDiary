import {
  savePet, getPets, removePet, getCurrentPet, setCurrentPet,
  addRecord, getRecords, updateRecord, removeRecord,
  getMessages, saveMessages, clearAll, persistPhotos, uid,
} from '../../utils/store';
import { today, addDays } from '../../utils/date';

afterEach(() => {
  clearAll();
});

describe('宠物档案', () => {
  test('添加宠物只需要名字与物种', () => {
    const pet = savePet({ name: '咪咪', species: '猫' });
    expect(getPets().length).toBe(1);
    expect(pet.name).toBe('咪咪');
    expect(getCurrentPet()!.id).toBe(pet.id);
  });

  test('编辑宠物保留必填项', () => {
    const pet = savePet({ name: '咪咪', species: '猫' });
    savePet({ id: pet.id, name: '咪咪酱', species: '猫', breed: '橘猫' });
    const updated = getPets()[0];
    expect(updated.name).toBe('咪咪酱');
    expect(updated.breed).toBe('橘猫');
  });

  test('删除宠物后其记录一并清除', () => {
    const pet = savePet({ name: '咪咪', species: '猫' });
    addRecord({ petId: pet.id, date: today(), text: '洗澡', tags: ['洗澡'], photos: [] });
    removePet(pet.id);
    expect(getRecords(pet.id).length).toBe(0);
    expect(getPets().length).toBe(0);
  });
});

describe('日记记录', () => {
  test('非法日期不能新增或修改，失败不破坏原记录', () => {
    const pet = savePet({ name: '咪咪', species: '猫' });
    const input = { petId: pet.id, date: '2026-02-30', text: '洗澡', tags: ['洗澡'], photos: [] };
    expect(() => addRecord(input)).toThrow('日期');
    expect(getRecords(pet.id)).toHaveLength(0);
    const record = addRecord({ ...input, date: today() });
    expect(() => updateRecord(record.id, { date: '2026-99-99' })).toThrow('日期');
    expect(getRecords(pet.id)[0].date).toBe(today());
  });
  test('按发生日期倒序', () => {
    const pet = savePet({ name: '咪咪', species: '猫' });
    const older = addRecord({ petId: pet.id, date: addDays(today(), -10), text: '十天前', tags: [], photos: [] });
    const newer = addRecord({ petId: pet.id, date: today(), text: '今天', tags: [], photos: [] });
    const list = getRecords(pet.id);
    expect(list[0].id).toBe(newer.id);
    expect(list[1].id).toBe(older.id);
  });

  test('编辑与删除生效', () => {
    const pet = savePet({ name: '咪咪', species: '猫' });
    const rec = addRecord({ petId: pet.id, date: today(), text: '原文', tags: ['洗澡'], photos: [] });
    updateRecord(rec.id, { text: '改后', date: addDays(today(), -1) });
    const updated = getRecords(pet.id)[0];
    expect(updated.text).toBe('改后');
    expect(updated.date).toBe(addDays(today(), -1));
    removeRecord(rec.id);
    expect(getRecords(pet.id).length).toBe(0);
  });

  test('纯照片记录可以保存', async () => {
    const pet = savePet({ name: '咪咪', species: '猫' });
    const paths = await persistPhotos(['tmp://a.jpg']);
    const rec = addRecord({ petId: pet.id, date: today(), text: '', tags: ['照片'], photos: paths });
    expect(getRecords(pet.id)[0].id).toBe(rec.id);
    expect(getRecords(pet.id)[0].photos.length).toBe(1);
  });
});

describe('聊天消息', () => {
  test('按宠物隔离', () => {
    const a = savePet({ name: 'A', species: '猫' });
    const b = savePet({ name: 'B', species: '狗' });
    const msg = { id: uid(), role: 'user' as const, kind: 'text' as const, text: 'A 的消息', time: Date.now() };
    saveMessages(a.id, [msg]);
    expect(getMessages(a.id).length).toBe(1);
    expect(getMessages(b.id).length).toBe(0);
  });
});
