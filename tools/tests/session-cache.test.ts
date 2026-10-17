import { callCloud } from '../../utils/cloud';
import { newSession, readSession, openSession, pushSession, saveLocalSession, loadLocalSession, pullSession, listSessions, MAX_MESSAGES } from '../../utils/chat-store';
import { setCloudSession, ChatMessage } from '../../utils/store';

jest.mock('../../utils/cloud', () => ({ callCloud: jest.fn() }));
jest.mock('../../utils/repository', () => ({
  resolvePhotoUrls: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `https://signed/${id}`])),
}));
const rpc = callCloud as jest.Mock;
const row = (text: string): ChatMessage => ({ id: text, role: 'user', kind: 'text', text, time: Date.now() });
beforeEach(() => { (wx as any).clearStorageSync(); rpc.mockReset(); setCloudSession({ userId: 'u', familyId: 'f' }); });

test('工具只读旧会话，不覆盖本机当前会话', async () => {
  const current = { ...newSession(), id: 'current', messages: [row('新话题')] };
  saveLocalSession('pet', current);
  rpc.mockResolvedValue({ id: 'old', version: 1, messages: [row('旧话题')] });
  expect((await readSession('pet', 'old')).messages[0].text).toBe('旧话题');
  expect(loadLocalSession('pet')!.id).toBe('current');
  await openSession('pet', 'old');
  expect(loadLocalSession('pet')!.id).toBe('old');
});

test('云端草稿恢复当前宠物归属，并保留云端照片标识', async () => {
  rpc.mockResolvedValue({ id: 'old', version: 1, messages: [{ ...row('草稿'), kind: 'draft', draft: {
    key: 'd', date: '2020-05-09', text: '洗澡', tags: [], photos: ['cloud://photo'], status: 'pending',
  } }] });
  const session = await readSession('pet', 'old');
  expect(session.messages[0].draft!.petId).toBe('pet');
  expect(session.messages[0].draft!.photoIds).toEqual(['cloud://photo']);
});

test('同步成功只更新云端身份和版本，不丢本机尚未入库照片与重试信息', async () => {
  const current = { ...newSession(), messages: [{ ...row('新图片'), photos: ['/local/photo'], sourceText: '  新图片  ', retry: true }] };
  rpc.mockResolvedValue({ id: 'cloud', version: 1, messages: [{ ...row('新图片'), photos: [] }] });
  const saved = await pushSession('pet', current);
  expect(rpc.mock.calls[0][1].messages[0].photos).toEqual([]);
  expect(saved.messages[0].photos).toEqual(['/local/photo']);
  expect(saved.messages[0].sourceText).toBe('  新图片  ');
  expect(saved.messages[0].retry).toBe(true);
  expect(saved.id).toBe('cloud');
  expect(loadLocalSession('pet')!.messages[0].photos).toEqual(['/local/photo']);
});

test('拉取相同版本不把云端不含照片的内容写进本机槽位', async () => {
  const current = { ...newSession(), id: 'cloud', version: 1, messages: [{ ...row('照片'), photos: ['/local/photo'] }] };
  saveLocalSession('pet', current);
  rpc.mockResolvedValue({ id: 'cloud', version: 1, messages: [{ ...row('照片'), photos: [] }] });
  expect((await pullSession('pet', current)).messages[0].photos).toEqual(['/local/photo']);
  expect(loadLocalSession('pet')!.messages[0].photos).toEqual(['/local/photo']);
});

test('超过文档上限不能静默截断旧消息', async () => {
  const current = { ...newSession(), messages: Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => row(String(i))) };
  await expect(pushSession('pet', current)).rejects.toThrow('话题已满');
  expect(rpc).not.toHaveBeenCalled();
});

test('同设备换话题后恢复未确认照片和原始照片，云端仍不上传它们', async () => {
  const photo = '/local/unsaved.jpg';
  const current = { ...newSession(), messages: [{ ...row('照片'), photos: [photo], draft: {
    key: 'card', petId: 'pet', date: null, text: '', tags: [], photos: [photo],
    status: 'pending' as const, rawInput: { text: '', photos: [photo] },
  } }] };
  let doc: any;
  rpc.mockImplementation(async (action, data) => {
    if (action === 'session.save') { doc = { ...data, id: 'old', version: 1 }; return doc; }
    return doc;
  });
  await pushSession('pet', current);
  saveLocalSession('pet', newSession());
  const restored = await openSession('pet', 'old');
  expect(doc.messages[0].photos).toEqual([]);
  expect(doc.messages[0].draft.photos).toEqual([]);
  expect(restored.messages[0].photos).toEqual([photo]);
  expect(restored.messages[0].draft!.rawInput!.photos).toEqual([photo]);
  setCloudSession({ userId: 'other', familyId: 'f' });
  expect((await readSession('pet', 'old')).messages[0].photos).toEqual([]);
});

test('旧话题后台同步保留照片快照，不覆盖当前话题', async () => {
  const old = { ...newSession(), messages: [{ ...row('照片'), photos: ['/local/photo'] }] };
  const current = newSession(); saveLocalSession('pet', current);
  rpc.mockResolvedValue({ id: 'old', version: 1, messages: [{ ...row('照片'), photos: [] }] });
  await pushSession('pet', old, false);
  expect(loadLocalSession('pet')!.clientId).toBe(current.clientId);
  expect((await readSession('pet', 'old')).messages[0].photos).toEqual(['/local/photo']);
});

test('读取等待中切换家庭，不写入另一家庭缓存', async () => {
  rpc.mockImplementation(async () => { setCloudSession({ userId: 'other', familyId: 'other' }); return { id: 'old', version: 1, messages: [] }; });
  await expect(openSession('pet', 'old')).rejects.toThrow('家庭空间已切换');
  expect(loadLocalSession('pet')).toBeNull();
});

test('本机未同步内容在重启、拉取新版和重新打开旧话题后均保留', async () => {
  const dirty = { ...newSession(), id: 'cloud', version: 1, dirty: true, messages: [row('本机独有')] };
  saveLocalSession('pet', dirty);
  rpc.mockResolvedValue({ id: 'cloud', version: 2, messages: [row('远端独有')] });
  expect((await pullSession('pet', loadLocalSession('pet')!)).messages[0].text).toBe('本机独有');
  saveLocalSession('pet', newSession());
  expect((await openSession('pet', 'cloud')).messages[0].text).toBe('本机独有');
  expect(loadLocalSession('pet')!.dirty).toBe(true);
});

test('首次同步失败的话题在目录可恢复，不要求先有云端 id', async () => {
  const dirty = { ...newSession(), dirty: true, messages: [row('尚未上云')] };
  saveLocalSession('pet', dirty); saveLocalSession('pet', newSession());
  rpc.mockResolvedValue({ items: [], next: '' });
  const index = await listSessions('pet');
  expect(index).toHaveLength(1);
  expect((await openSession('pet', index[0].id)).messages[0].text).toBe('尚未上云');
});
