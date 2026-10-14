/** 聊天会话：一话题一文档、按用户隔离、100 条上限、版本号防覆盖 */
import { memoryDatabase } from './helpers/cloud-db';
const { createService } = require('../../cloudfunctions/diaryApi/service');
let db: any;
let service: any;
let clock: number;
let sequence: number;
const context = (name = 'alice') => ({ OPENID: name, APPID: 'app' });
const call = (action: string, data: any = {}, name = 'alice') => service({ action, data }, context(name));
async function setup() {
  const u = await call('auth.login', {}, 'alice');
  const f = (await call('family.list', {}, 'alice'))[0];
  const pet = await call('pet.save', { familyId: f.id, clientId: 'pet-one', name: '点点', species: '猫' });
  return { userId: u.id, familyId: f.id, petId: pet.id };
}
const msg = (id: string, text: string) => ({ id, role: 'user', kind: 'text', text, photos: [], time: 1 });

beforeEach(() => {
  db = memoryDatabase(); clock = 1791792000000; sequence = 0;
  service = createService({ db, storage: {
    uploadFile: async ({ cloudPath }: any) => ({ fileID: `cloud://env/${cloudPath}` }),
    getTempFileURL: async ({ fileList }: any) => ({ fileList: fileList.map((fileID: string) => ({ fileID, status: 0, tempFileURL: `https://signed/${fileID}` })) }),
  }, now: () => clock, token: () => (++sequence).toString().padStart(48, 'a') });
});

test('新建会话幂等：相同 clientId 不产生第二个文档', async () => {
  const { familyId, petId } = await setup();
  const first = await call('session.save', { familyId, petId, clientId: 's-one', messages: [msg('m1', '今天洗澡了')] });
  const again = await call('session.save', { familyId, petId, clientId: 's-one', messages: [msg('m1', '今天洗澡了')] });
  expect(again.id).toBe(first.id);
  expect(db.dump('chat_sessions')).toHaveLength(1);
});

test('会话按用户隔离：家人看不到我的对话', async () => {
  const { familyId, petId } = await setup();
  const invite = await call('invite.create', { familyId });
  await call('auth.login', {}, 'bob');
  await call('invite.accept', { token: invite.token }, 'bob');
  await call('session.save', { familyId, petId, clientId: 's-one', messages: [msg('m1', '我的对话')] });
  const mine = await call('session.list', { familyId, petId });
  const theirs = await call('session.list', { familyId, petId }, 'bob');
  expect(mine.items).toHaveLength(1);
  expect(theirs.items).toHaveLength(0);
  await expect(call('session.get', { familyId, petId, id: mine.items[0].id }, 'bob')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('带版本号保存可更新；版本落后时拒绝覆盖', async () => {
  const { familyId, petId } = await setup();
  const s = await call('session.save', { familyId, petId, clientId: 's-one', messages: [msg('m1', '第一次')] });
  const updated = await call('session.save', { familyId, petId, id: s.id, version: s.version,
    messages: [msg('m1', '第一次'), msg('m2', '第二次')], title: '洗澡那点事' });
  expect(updated.version).toBe(2);
  expect(updated.messageCount).toBe(2);
  expect(updated.title).toBe('洗澡那点事');
  await expect(call('session.save', { familyId, petId, id: s.id, version: 1, messages: [] }))
    .rejects.toMatchObject({ code: 'CONFLICT' });
});

test('单会话 100 条上限，超出拒绝保存', async () => {
  const { familyId, petId } = await setup();
  const many = Array.from({ length: 101 }, (_, i) => msg(`m${i}`, `第${i}句`));
  await expect(call('session.save', { familyId, petId, clientId: 's-one', messages: many }))
    .rejects.toMatchObject({ code: 'INVALID' });
  await expect(call('session.save', { familyId, petId, clientId: 's-one', messages: many.slice(0, 100) }))
    .resolves.toMatchObject({ messageCount: 100 });
});

test('消息只接受合法结构与已登记照片；删除为软删除且不可再取', async () => {
  const { familyId, petId } = await setup();
  await expect(call('session.save', { familyId, petId, clientId: 's-one',
    messages: [{ id: 'm1', role: 'stranger', kind: 'text', text: 'x', photos: [], time: 1 }] }))
    .rejects.toMatchObject({ code: 'INVALID' });
  await expect(call('session.save', { familyId, petId, clientId: 's-one',
    messages: [{ id: 'm1', role: 'user', kind: 'text', text: 'x', photos: ['cloud://unknown'], time: 1 }] }))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  const s = await call('session.save', { familyId, petId, clientId: 's-one', messages: [msg('m1', '你好')] });
  await call('session.delete', { familyId, petId, id: s.id });
  expect((await call('session.list', { familyId, petId })).items).toHaveLength(0);
  await expect(call('session.get', { familyId, petId, id: s.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('会话目录只返回索引，正文通过 session.get 单独取', async () => {
  const { familyId, petId } = await setup();
  const s = await call('session.save', { familyId, petId, clientId: 's-one',
    messages: [msg('m1', '今天洗澡了')], title: '洗澡', summary: '讨论了洗澡后吹干' });
  const index = (await call('session.list', { familyId, petId })).items[0];
  expect(index).toEqual({ id: s.id, title: '洗澡', summary: '讨论了洗澡后吹干', messageCount: 1,
    startedAt: clock, updatedAt: clock, version: 1 });
  expect((index as any).messages).toBeUndefined();
  const full = await call('session.get', { familyId, petId, id: s.id });
  expect(full.messages[0].text).toBe('今天洗澡了');
});
