import { callCloud } from '../../utils/cloud';
import { newSession, readSession, openSession, pushSession, saveLocalSession, loadLocalSession, pullSession, MAX_MESSAGES } from '../../utils/chat-store';
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

test('读取等待中切换家庭，不写入另一家庭缓存', async () => {
  rpc.mockImplementation(async () => { setCloudSession({ userId: 'other', familyId: 'other' }); return { id: 'old', version: 1, messages: [] }; });
  await expect(openSession('pet', 'old')).rejects.toThrow('家庭空间已切换');
  expect(loadLocalSession('pet')).toBeNull();
});
