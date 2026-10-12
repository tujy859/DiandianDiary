import { memoryDatabase } from './helpers/cloud-db';
const { createService } = require('../../cloudfunctions/diaryApi/service');
const { adapter } = require('../../cloudfunctions/diaryApi/database');
let db: any;
let service: any;
let storage: any;
let clock: number;
let sequence: number;
const context = (name = 'alice', appid = 'app') => ({ OPENID: name, APPID: appid });
const call = (action: string, data: any = {}, name = 'alice') => service({ action, data }, context(name));
async function setupUser(name = 'alice') {
  const u = await call('auth.login', {}, name);
  const f = (await call('family.list', {}, name))[0];
  return { userId: u.id, familyId: f.id };
}
async function setupPet() {
  const { familyId } = await setupUser();
  const pet = await call('pet.save', { familyId, clientId: 'pet-one', name: '点点', species: '猫' });
  return { familyId, pet };
}
async function join(familyId: string, name = 'bob') {
  const user = await setupUser(name);
  const invite = await call('invite.create', { familyId });
  await call('invite.accept', { token: invite.token }, name);
  return user;
}
const diary = (familyId: string, petId: string, clientId = 'record-one') => ({ familyId, petId, clientId,
  rawInput: { text: '今天早晨给点点洗了澡，乖乖的', photos: [] },
  formatted: { date: '2026-10-12', text: '点点洗澡', tags: ['洗澡'], photos: [] }, mode: 'tool' });

beforeEach(() => {
  db = memoryDatabase(); clock = 1791792000000; sequence = 0;
  storage = { uploadFile: jest.fn(async ({ cloudPath }) => ({ fileID: `cloud://env/${cloudPath}` })),
    getTempFileURL: jest.fn(async ({ fileList }) => ({ fileList: fileList.map((fileID: string) => ({ fileID, status: 0, tempFileURL: `https://signed.example/${fileID}` })) })) };
  service = createService({ db, storage, now: () => clock, token: () => (++sequence).toString().padStart(48, 'a') });
});

test('身份只来自微信上下文；并发重复登录只有一个用户和默认家庭', async () => {
  await expect(service({ action: 'auth.login', data: { OPENID: 'alice' } }, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  const [a, b] = await Promise.all([call('auth.login'), call('auth.login')]);
  expect(a.id).toBe(b.id);
  expect(a.openid).toBeUndefined();
  expect(db.dump('users')).toHaveLength(1);
  expect(db.dump('families')).toHaveLength(1);
  const other = await service({ action: 'auth.login' }, context('alice', 'different-app'));
  expect(other.id).not.toBe(a.id);
});

test('家庭共享同一宠物，第三人及伪造角色不能读写', async () => {
  const { familyId, pet } = await setupPet();
  await join(familyId);
  const outsider = await setupUser('eve');
  expect((await call('pet.list', { familyId }, 'bob')).items[0].id).toBe(pet.id);
  await expect(call('pet.list', { familyId, userId: outsider.userId, role: 'owner' }, 'eve')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(call('pet.save', { familyId, id: pet.id, version: 1, name: '改名', species: '猫', role: 'owner' }, 'bob')).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('原始输入和整理结果独立保存；编辑不能覆盖原文或作者', async () => {
  const { familyId, pet } = await setupPet();
  const input = diary(familyId, pet.id);
  const first = await call('diary.save', input);
  const second = await call('diary.save', { ...input, id: first.id, version: first.version,
    rawInput: { text: '恶意替换', photos: [] }, createdBy: 'fake', familyId,
    formatted: { ...input.formatted, text: '补充整理结果' } });
  expect(second.rawInput.text).toBe(input.rawInput.text);
  expect(second.formatted.text).toBe('补充整理结果');
  expect(second.createdBy).toBe(first.createdBy);
  expect(second.version).toBe(2);
  expect(second.formatting).toEqual({ schemaVersion: 1, mode: 'tool' });
});

test('重复提交和并发重试不新增重复日记', async () => {
  const { familyId, pet } = await setupPet();
  const input = diary(familyId, pet.id);
  const [one, two] = await Promise.all([call('diary.save', input), call('diary.save', input)]);
  expect(one.id).toBe(two.id);
  expect(db.dump('diaries')).toHaveLength(1);
});

test('作者只能编辑自己的日记，家庭创建者可管理全部日记', async () => {
  const { familyId, pet } = await setupPet();
  await join(familyId);
  const own = await call('diary.save', diary(familyId, pet.id), 'alice');
  await expect(call('diary.save', { ...diary(familyId, pet.id), id: own.id, version: 1 }, 'bob')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const member = await call('diary.save', diary(familyId, pet.id, 'bob-record'), 'bob');
  const edited = await call('diary.save', { ...diary(familyId, pet.id), id: member.id, version: 1 }, 'alice');
  expect(edited.updatedBy).not.toBe(edited.createdBy);
});

test('跨家庭宠物/日记引用被拒绝', async () => {
  const { familyId, pet } = await setupPet();
  const second = await call('family.create', { name: '另一个家', clientId: 'second' });
  await expect(call('diary.save', diary(second.id, pet.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const d = await call('diary.save', diary(familyId, pet.id));
  await expect(call('diary.get', { familyId: second.id, id: d.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test.each(['2026-02-30', '2026-99-99', '2026-1-2', 'bad'])('非法日期 %s 返回业务错误，事务没有部分写入', async (date) => {
  const { familyId, pet } = await setupPet();
  const input = diary(familyId, pet.id);
  input.formatted.date = date;
  const before = db.dump('families')[0].revision;
  await expect(call('diary.save', input)).rejects.toMatchObject({ code: 'INVALID' });
  expect(db.dump('diaries')).toHaveLength(0);
  expect(db.dump('families')[0].revision).toBe(before);
});

test('多人并发修改只有一个版本提交成功', async () => {
  const { familyId, pet } = await setupPet();
  const input = diary(familyId, pet.id);
  const d = await call('diary.save', input);
  const outcomes = await Promise.allSettled([call('diary.save', { ...input, id: d.id, version: 1 }), call('diary.save', { ...input, id: d.id, version: 1 })]);
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('CONFLICT');
});

test('邀请码存哈希；并发使用只有一个新成员成功，原用户可幂等重试', async () => {
  const { familyId } = await setupPet();
  await setupUser('bob'); await setupUser('eve');
  const invite = await call('invite.create', { familyId });
  expect(JSON.stringify(db.dump('invites'))).not.toContain(invite.token);
  const result = await Promise.allSettled(['bob', 'eve'].map((name) => call('invite.accept', { token: invite.token }, name)));
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const winner = result[0].status === 'fulfilled' ? 'bob' : 'eve';
  expect((await call('invite.accept', { token: invite.token }, winner)).members).toHaveLength(2);
});

test('邀请码过期和撤销都不能加入；成员无法邀请或移除创建者', async () => {
  const { familyId } = await setupPet();
  const first = await call('invite.create', { familyId });
  await setupUser('bob');
  clock += 24 * 60 * 60 * 1000;
  await expect(call('invite.accept', { token: first.token }, 'bob')).rejects.toMatchObject({ code: 'INVALID_INVITE' });
  const second = await call('invite.create', { familyId });
  await call('invite.revoke', { familyId, token: second.token });
  await expect(call('invite.accept', { token: second.token }, 'bob')).rejects.toMatchObject({ code: 'INVALID_INVITE' });
  await join(familyId);
  await expect(call('invite.create', { familyId }, 'bob')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(call('family.leave', { familyId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('移除成员立即禁止后续读取、写入和照片链接，原有日记保留', async () => {
  const { familyId, pet } = await setupPet();
  const member = await join(familyId);
  await call('diary.save', diary(familyId, pet.id), 'bob');
  await call('family.removeMember', { familyId, userId: member.userId });
  for (const action of ['pet.list', 'diary.save', 'media.urls']) {
    await expect(call(action, { ...diary(familyId, pet.id), fileIds: [] }, 'bob')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  expect(db.dump('diaries')).toHaveLength(1);
  expect((await call('family.list', {}, 'bob')).some((f: any) => f.id === familyId)).toBe(false);
});

test('删除宠物隐藏其日记；已删除请求 ID 不能复活资源', async () => {
  const { familyId, pet } = await setupPet();
  const d = await call('diary.save', diary(familyId, pet.id));
  await call('pet.delete', { familyId, id: pet.id, version: 1 });
  expect((await call('pet.list', { familyId })).items).toHaveLength(0);
  await expect(call('diary.get', { familyId, id: d.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(call('pet.save', { familyId, clientId: 'pet-one', name: '点点', species: '猫' })).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('成员写入与移除并发时，旧权限快照不能在移除后提交', async () => {
  const { familyId, pet } = await setupPet();
  const member = await join(familyId);
  const originalTransaction = db.transaction;
  let release: () => void = () => {};
  let started: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let held = false;
  db.transaction = (work: any) => originalTransaction(async (tx: any) => {
    const result = await work(tx);
    if (!held) { held = true; started(); await gate; }
    return result;
  });
  const writing = call('diary.save', diary(familyId, pet.id), 'bob');
  const observed = writing.catch((e: any) => e);
  await ready;
  await call('family.removeMember', { familyId, userId: member.userId });
  release();
  expect((await observed).code).toBe('FORBIDDEN');
  expect(db.dump('diaries')).toHaveLength(0);
});

test('私有照片上传可幂等重试，跨家庭 fileID 和非图像上传被拒绝', async () => {
  const { familyId, pet } = await setupPet();
  const base64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64');
  const first = await call('media.upload', { familyId, base64 });
  const second = await call('media.upload', { familyId, base64 });
  expect(first.fileId).toBe(second.fileId);
  expect(db.dump('media')).toHaveLength(1);
  const other = await call('family.create', { name: '另一个家', clientId: 'second' });
  await expect(call('media.urls', { familyId: other.id, fileIds: [first.fileId] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(storage.getTempFileURL).not.toHaveBeenCalled();
  await expect(call('media.upload', { familyId, base64: Buffer.from('not a photo').toString('base64') })).rejects.toMatchObject({ code: 'INVALID' });
  const input = diary(familyId, pet.id);
  input.formatted.photos = [first.fileId];
  await call('diary.save', input);
  expect((await call('media.urls', { familyId, fileIds: [first.fileId] }))[0].url).toContain('https://');
});

test('分页游标稳定且不会漏读或混入其他家庭', async () => {
  const { familyId, pet } = await setupPet();
  for (let i = 0; i < 23; i++) await call('diary.save', diary(familyId, pet.id, `record-${i}`));
  const first = await call('diary.list', { familyId, petId: pet.id, limit: 10 });
  const second = await call('diary.list', { familyId, petId: pet.id, after: first.next, limit: 10 });
  const third = await call('diary.list', { familyId, petId: pet.id, after: second.next, limit: 10 });
  expect(first.items).toHaveLength(10); expect(second.items).toHaveLength(10); expect(third.items).toHaveLength(3);
  expect(new Set(first.items.concat(second.items, third.items).map((d: any) => d.id)).size).toBe(23);
  expect(third.next).toBe('');
});

test('数据库适配保留事务结果；业务错误回滚且不重试；平台冲突重试', async () => {
  const business = Object.assign(new Error('禁止'), { public: true });
  const rollback = jest.fn(async () => {});
  const commit = jest.fn().mockRejectedValueOnce(new Error('TransactionConflict')).mockResolvedValue(undefined);
  const root = { startTransaction: jest.fn(async () => ({ commit, rollback })) };
  const database = adapter(root);
  await expect(database.transaction(async () => ({ id: 'saved' }))).resolves.toEqual({ id: 'saved' });
  expect(root.startTransaction).toHaveBeenCalledTimes(2);
  await expect(database.transaction(async () => { throw business; })).rejects.toBe(business);
  expect(root.startTransaction).toHaveBeenCalledTimes(3);
  expect(rollback).toHaveBeenCalledTimes(2);
});

test('数据库适配不把网络/权限故障当作文档不存在', async () => {
  const error = Object.assign(new Error('permission denied'), { errCode: -502003 });
  const root = { collection: () => ({ doc: () => ({ get: async () => { throw error; } }) }) };
  await expect(adapter(root).get('users', 'id')).rejects.toBe(error);
});
