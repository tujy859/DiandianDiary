import { memoryDatabase } from './helpers/cloud-db';
const { createService, hash } = require('../../cloudfunctions/diaryApi/service');
const { storageAdapter } = require('../../cloudfunctions/diaryApi/storage');
let db: any, service: any, storage: any, files: Map<string, Buffer>, clock: number, familyId: string;
const call = (action: string, data: any = {}, name = 'alice') => service({ action, data }, { APPID: 'app', OPENID: name });
const jpg = () => Buffer.from([255, 216, 255, 224, 1]);
async function stage(bytes = jpg()) {
  const grant = await call('media.prepare', { familyId });
  const ticket = await db.get('media_uploads', grant.uploadId);
  files.set(ticket.stagingFileId, bytes);
  return { grant, ticket };
}
beforeEach(async () => {
  db = memoryDatabase(); files = new Map(); clock = 1792077460000;
  let sequence = 0;
  storage = {
    prepareUpload: jest.fn(async (path: string) => ({ fileId: `cloud://env/${path}`, url: `https://upload.example/${path}`, headers: { authorization: 'demo-signature' } })),
    downloadFile: jest.fn(async ({ fileID }: any) => ({ fileContent: files.get(fileID) })),
    uploadFile: jest.fn(async ({ cloudPath, fileContent }: any) => {
      const fileID = `cloud://env/${cloudPath}`;
      files.set(fileID, Buffer.from(fileContent)); return { fileID };
    }),
    deleteFile: jest.fn(async ({ fileList }: any) => fileList.forEach((id: string) => files.delete(id))),
    getTempFileURL: jest.fn(async ({ fileList }: any) => ({ fileList: fileList.map((fileID: string) => ({ fileID, status: 0, tempFileURL: 'https://download.example/photo' })) })),
  };
  service = createService({ db, storage, now: () => clock, token: () => String(++sequence) });
  await call('auth.login'); familyId = (await call('family.list'))[0].id;
});

test('临时文件不能直接引用；大照片原样定稿后可读取，重试不重复写存储', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024); jpg().copy(bytes);
  const { grant, ticket } = await stage(bytes);
  await expect(call('media.urls', { familyId, fileIds: [ticket.stagingFileId] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const result = await call('media.complete', { familyId, uploadId: grant.uploadId });
  expect(files.get(result.fileId)!.equals(bytes)).toBe(true);
  expect(files.has(ticket.stagingFileId)).toBe(false);
  expect(db.dump('media')).toHaveLength(1);
  await expect(call('media.complete', { familyId, uploadId: grant.uploadId })).resolves.toEqual(result);
  expect(storage.uploadFile).toHaveBeenCalledTimes(1);
  await expect(call('media.urls', { familyId, fileIds: [result.fileId] })).resolves.toHaveLength(1);
});

test('同家庭成员也不能确认别人的上传，其他家庭不能冒用上传 ID', async () => {
  const { grant } = await stage();
  await call('auth.login', {}, 'bob');
  const invite = await call('invite.create', { familyId });
  await call('invite.accept', { token: invite.token }, 'bob');
  await expect(call('media.complete', { familyId, uploadId: grant.uploadId }, 'bob')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const other = await call('family.create', { name: '演示家庭', clientId: 'other' });
  await expect(call('media.complete', { familyId: other.id, uploadId: grant.uploadId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(storage.downloadFile).not.toHaveBeenCalled();
});

test('无效图片与过期上传不能登记，不把未验证文件作为照片', async () => {
  const invalid = await stage(Buffer.from('not an image'));
  await expect(call('media.complete', { familyId, uploadId: invalid.grant.uploadId })).rejects.toMatchObject({ code: 'INVALID' });
  const expired = await stage(); clock += 31 * 60 * 1000;
  await expect(call('media.complete', { familyId, uploadId: expired.grant.uploadId })).rejects.toMatchObject({ code: 'INVALID' });
  expect(db.dump('media')).toHaveLength(0);
  expect(storage.uploadFile).not.toHaveBeenCalled();
});

test('下载过程中家庭关闭，后续登记事务必须重新拒绝访问', async () => {
  const { grant } = await stage();
  storage.downloadFile.mockImplementationOnce(async ({ fileID }: any) => {
    const snapshot = await call('family.summary', { familyId });
    await call('family.dissolve', { familyId, revision: snapshot.revision });
    return { fileContent: files.get(fileID) };
  });
  await expect(call('media.complete', { familyId, uploadId: grant.uploadId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.dump('media')).toHaveLength(0);
});

test('临时上传地址被再次使用也不能修改已登记的正式照片', async () => {
  const { grant, ticket } = await stage();
  const result = await call('media.complete', { familyId, uploadId: grant.uploadId });
  files.set(ticket.stagingFileId, Buffer.from('replacement'));
  expect((await call('media.complete', { familyId, uploadId: grant.uploadId })).fileId).toBe(result.fileId);
  expect(files.get(result.fileId)).toEqual(jpg());
  expect(await db.get('media', hash(result.fileId))).toHaveProperty('familyId', familyId);
});

test('PNG 与 iOS HEIC 保留原始编码，格式依据内容判断', async () => {
  for (const [bytes, suffix] of [[Buffer.from('89504e470d0a1a0a0102', 'hex'), '.png'],
    [Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(12)]), '.heic']] as const) {
    const { grant } = await stage(bytes);
    const result = await call('media.complete', { familyId, uploadId: grant.uploadId });
    expect(result.fileId.endsWith(suffix)).toBe(true);
    expect(files.get(result.fileId)).toEqual(bytes);
  }
});

test('旧上传接口也识别 800KB HEIC，格式问题不会误提示为大小超限', async () => {
  const bytes = Buffer.alloc(800 * 1024);
  bytes.writeUInt32BE(24, 0); bytes.write('ftypheic', 4, 'ascii');
  const result = await call('media.upload', { familyId, base64: bytes.toString('base64') });
  expect(result.fileId.endsWith('.heic')).toBe(true);
  expect(files.get(result.fileId)!.equals(bytes)).toBe(true);
  await expect(call('media.upload', { familyId, base64: Buffer.from('not an image').toString('base64') }))
    .rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('照片格式') });
  const tooLarge = Buffer.alloc(1024 * 1024 + 1); jpg().copy(tooLarge);
  await expect(call('media.upload', { familyId, base64: tooLarge.toString('base64') }))
    .rejects.toMatchObject({ code: 'INVALID', message: '照片超过旧版上传容量，请更新小程序后重试' });
});

test('正式文件上传成功但登记失败时，不宣称完成；可安全重试', async () => {
  const { grant } = await stage();
  const transaction = db.transaction;
  db.transaction = async () => { throw new Error('database unavailable'); };
  await expect(call('media.complete', { familyId, uploadId: grant.uploadId })).rejects.toThrow('database unavailable');
  expect(db.dump('media')).toHaveLength(0);
  db.transaction = transaction;
  await expect(call('media.complete', { familyId, uploadId: grant.uploadId })).resolves.toHaveProperty('fileId');
  expect(db.dump('media')).toHaveLength(1);
});

test('实际锁定的 CloudBase SDK 获取 PUT 元数据，适配器仅返回临时路径的授权', async () => {
  const sdk = require('../../cloudfunctions/diaryApi/node_modules/@cloudbase/node-sdk');
  const transport = require('../../cloudfunctions/diaryApi/node_modules/@cloudbase/node-sdk/dist/utils/tcbapirequester');
  const request = jest.spyOn(transport, 'request').mockResolvedValue({ data: {
    url: 'https://upload.example/path', authorization: 'demo-signature', token: 'demo-token', fileId: 'cloud://env/pending/demo', cosFileId: 'demo-cos-id',
  } });
  try {
    const client = sdk.init({ env: 'sdk-contract-test' });
    const result = await storageAdapter({}, client).prepareUpload('pending/demo');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ params: { action: 'storage.getUploadMetadata', path: 'pending/demo', method: 'put' } }));
    expect(result).toMatchObject({ fileId: 'cloud://env/pending/demo', headers: { authorization: 'demo-signature', key: 'pending%2Fdemo', 'content-type': 'application/octet-stream' } });
  } finally { request.mockRestore(); }
});
