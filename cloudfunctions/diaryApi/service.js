const crypto = require('crypto');
const hash = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fail = (code, message) => { const e = new Error(message); e.code = code; e.public = true; throw e; };
function string(value, name, max = 100, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail('INVALID', `${name}无效`);
  return value;
}
function date(value, empty = false) {
  if (empty && value === '') return '';
  string(value, '日期', 10);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('INVALID', '日期无效');
  return value;
}
function array(value, name, max, itemMax) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID', `${name}无效`);
  return value.map((v) => string(v, name, itemMax));
}
const publicUser = (u) => ({ id: u._id, nickname: u.nickname, createdAt: u.createdAt });
const publicDoc = (d) => { const { _id, ...rest } = d; return { id: _id, ...rest }; };
const AVATARS = { 'cat-cream-orange': '猫', 'cat-british-longhair-gray': '猫', 'dog-cream': '狗', 'other-paw': '其他' };
function petAvatarId(value, species) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(AVATARS, value) || AVATARS[value] !== species) fail('INVALID', '请选择对应物种的头像');
  return value;
}

function createService({ db, storage, now = Date.now, token = () => crypto.randomBytes(24).toString('hex') }) {
  async function family(reader, familyId, uid, owner = false) {
    string(familyId, '家庭 ID');
    const f = await reader.get('families', familyId);
    const member = f && f.members.find((m) => m.userId === uid);
    if (!member) fail('FORBIDDEN', '你已不在这个家庭空间中');
    if (owner && member.role !== 'owner') fail('FORBIDDEN', '仅家庭创建者可执行此操作');
    return f;
  }
  async function entity(reader, collection, id, familyId) {
    const result = await reader.get(collection, string(id, '记录 ID'));
    if (!result || result.familyId !== familyId || result.deletedAt !== null) fail('NOT_FOUND', '数据不存在或已删除');
    return result;
  }
  function version(doc, expected) {
    if (!Number.isInteger(expected) || doc.version !== expected) fail('CONFLICT', '记录已被修改，请刷新后再编辑');
  }
  async function photoIds(reader, ids, familyId) {
    const result = array(ids, '照片', 9, 500);
    for (const id of result) {
      const media = await reader.get('media', hash(id));
      if (!media || media.familyId !== familyId) fail('FORBIDDEN', '照片不属于当前家庭');
    }
    return result;
  }
  async function formatted(reader, value, familyId) {
    if (!value || typeof value !== 'object') fail('INVALID', '整理结果无效');
    const result = {
      date: date(value.date), text: string(value.text, '日记内容', 12000, true),
      tags: array(value.tags, '标签', 20, 30), photos: await photoIds(reader, value.photos, familyId),
    };
    if (!result.text.trim() && !result.photos.length) fail('INVALID', '请填写日记或添加照片');
    return result;
  }
  async function rawInput(reader, value, familyId) {
    if (!value || typeof value !== 'object') fail('INVALID', '原始输入无效');
    return {
      text: string(value.text, '原始输入', 12000, true), photos: await photoIds(reader, value.photos, familyId),
      provenance: value.provenance === 'legacy' ? 'legacy' : 'direct',
    };
  }
  /** 会话消息：只接受结构化字段与已登记的照片 fileId，单会话上限 100 条 */
  async function sessionMessages(reader, value, familyId) {
    if (!Array.isArray(value) || value.length > 100) fail('INVALID', '会话消息无效');
    const out = [];
    for (const m of value) {
      if (!m || typeof m !== 'object') fail('INVALID', '会话消息无效');
      if (m.role !== 'user' && m.role !== 'ai') fail('INVALID', '消息角色无效');
      if (!['text', 'draft', 'query', 'divider'].includes(m.kind)) fail('INVALID', '消息类型无效');
      const item = {
        id: string(m.id, '消息 ID', 64),
        role: m.role,
        kind: m.kind,
        text: string(m.text || '', '消息内容', 12000, true),
        photos: await photoIds(reader, Array.isArray(m.photos) ? m.photos : [], familyId),
        time: Number.isFinite(m.time) ? m.time : now(),
      };
      if (m.mode && ['model', 'tool', 'manual'].includes(m.mode)) item.mode = m.mode;
      if (m.draft && typeof m.draft === 'object') {
        item.draft = {
          key: string(m.draft.key || '', '草稿标识', 64, true),
          date: m.draft.date ? date(m.draft.date) : '',
          text: string(m.draft.text || '', '草稿内容', 12000, true),
          tags: array(m.draft.tags || [], '标签', 20, 30),
          photos: await photoIds(reader, Array.isArray(m.draft.photos) ? m.draft.photos : [], familyId),
          status: ['pending', 'saved', 'failed', 'discarded'].includes(m.draft.status) ? m.draft.status : 'pending',
          recordId: string(m.draft.recordId || '', '关联日记', 64, true),
          rawInput: m.draft.rawInput ? await rawInput(reader, m.draft.rawInput, familyId) : null,
        };
      }
      if (Array.isArray(m.refs)) {
        item.refs = m.refs.slice(0, 20).map((r) => ({
          recordId: string(r && r.recordId, '引用记录', 64),
          label: string((r && r.label) || '', '引用标题', 120, true),
          sub: string((r && r.sub) || '', '引用说明', 120, true),
        }));
      }
      out.push(item);
    }
    return out;
  }
  let collectionsReady = false;
  /** 冷启动时补建集合，避免「集合不存在」把整次请求打回去；已存在时静默跳过 */
  async function ensureCollections() {
    if (collectionsReady || typeof db.ensure !== 'function') return;
    for (const name of ['chat_sessions']) {
      try { await db.ensure(name); } catch (e) { /* 权限不足时忽略，写入时会给出明确错误 */ }
    }
    collectionsReady = true;
  }
  async function scopedWrite(familyId, uid, owner, work) {
    return db.transaction(async (tx) => {
      const f = await family(tx, familyId, uid, owner);
      const result = await work(tx, f);
      // Serialize writes with membership changes: a concurrent removal cannot authorize a stale write.
      await tx.set('families', f._id, { ...f, revision: f.revision + 1, updatedAt: now() });
      return result;
    });
  }
  async function login(uid, context) {
    return db.transaction(async (tx) => {
      let u = await tx.get('users', uid);
      if (!u) {
        const fid = `f_${hash(uid).slice(0, 40)}`;
        const t = now();
        u = { _id: uid, openid: context.OPENID, appid: context.APPID, nickname: '', familyIds: [fid], createdAt: t };
        await tx.set('users', uid, u);
        await tx.set('families', fid, { _id: fid, name: '我的宠物家庭', members: [{ userId: uid, role: 'owner', joinedAt: t }], revision: 1, createdAt: t, updatedAt: t });
      }
      return publicUser(u);
    });
  }
  return async function handle(event, context) {
    await ensureCollections();
    if (!context || !context.OPENID || !context.APPID) fail('UNAUTHENTICATED', '请从微信小程序登录');
    if (process.env.WECHAT_APP_ID && context.APPID !== process.env.WECHAT_APP_ID) fail('UNAUTHENTICATED', '小程序身份无效');
    const uid = `u_${hash(context.APPID, context.OPENID).slice(0, 40)}`;
    if (!event || typeof event.action !== 'string') fail('INVALID', '操作无效');
    const { action } = event;
    const p = event.data || {};
    if (action === 'auth.login') return login(uid, context);
    const user = await db.get('users', uid);
    if (!user) fail('UNAUTHENTICATED', '请先登录');
    if (action === 'user.profile') {
      const nickname = string(p.nickname, '昵称', 40, true).trim();
      return db.transaction(async (tx) => {
        const current = await tx.get('users', uid);
        await tx.set('users', uid, { ...current, nickname });
        return { ...publicUser(current), nickname };
      });
    }
    if (action === 'family.list') {
      const families = [];
      for (const id of user.familyIds) {
        const f = await db.get('families', id);
        if (!f || !f.members.some((m) => m.userId === uid)) continue;
        // 成员昵称只用于展示（不含 openid 等身份信息）
        const members = [];
        for (const m of f.members) {
          const u = await db.get('users', m.userId);
          members.push({ userId: m.userId, role: m.role, joinedAt: m.joinedAt, nickname: (u && u.nickname) || '' });
        }
        families.push({ ...publicDoc(f), members });
      }
      return families;
    }
    if (action === 'family.create') {
      const name = string(p.name, '家庭名称', 40).trim();
      const id = `f_${hash(uid, string(p.clientId, '请求 ID')).slice(0, 40)}`;
      return db.transaction(async (tx) => {
        const u = await tx.get('users', uid);
        const existing = await tx.get('families', id);
        if (existing) return publicDoc(await family(tx, id, uid));
        if (u.familyIds.length >= 10) fail('LIMIT', '最多加入 10 个家庭');
        const t = now();
        const f = { _id: id, name, members: [{ userId: uid, role: 'owner', joinedAt: t }], revision: 1, createdAt: t, updatedAt: t };
        await tx.set('families', id, f);
        await tx.set('users', uid, { ...u, familyIds: u.familyIds.concat(id) });
        return publicDoc(f);
      });
    }
    if (action === 'invite.accept') {
      const inviteId = hash(string(p.token, '邀请码', 48));
      return db.transaction(async (tx) => {
        const invite = await tx.get('invites', inviteId);
        if (!invite || invite.revoked || invite.expiresAt <= now()) fail('INVALID_INVITE', '邀请码无效或已过期');
        const f = await tx.get('families', invite.familyId);
        const u = await tx.get('users', uid);
        if (!f || !f.members.some((m) => m.userId === invite.createdBy && m.role === 'owner')) fail('INVALID_INVITE', '邀请已失效');
        if (invite.usedBy) {
          if (invite.usedBy === uid && f.members.some((m) => m.userId === uid)) return publicDoc(f);
          fail('INVALID_INVITE', '邀请码已被使用');
        }
        if (f.members.some((m) => m.userId === uid)) return publicDoc(f);
        if (f.members.length >= 20 || u.familyIds.length >= 10) fail('LIMIT', '家庭成员或家庭数量已达上限');
        const updated = { ...f, members: f.members.concat({ userId: uid, role: 'member', joinedAt: now() }), revision: f.revision + 1, updatedAt: now() };
        await tx.set('families', f._id, updated);
        await tx.set('users', uid, { ...u, familyIds: u.familyIds.concat(f._id) });
        await tx.set('invites', inviteId, { ...invite, usedBy: uid, usedAt: now() });
        return publicDoc(updated);
      });
    }
    const fid = p.familyId;
    if (action === 'invite.create') {
      const secret = token();
      return scopedWrite(fid, uid, true, async (tx) => {
        const expiresAt = now() + 24 * 60 * 60 * 1000;
        await tx.set('invites', hash(secret), { familyId: fid, createdBy: uid, expiresAt, usedBy: null, revoked: false });
        return { token: secret, expiresAt };
      });
    }
    if (action === 'invite.revoke') {
      return scopedWrite(fid, uid, true, async (tx) => {
        const id = hash(string(p.token, '邀请码', 48));
        const invite = await tx.get('invites', id);
        if (!invite || invite.familyId !== fid) fail('NOT_FOUND', '邀请不存在');
        await tx.set('invites', id, { ...invite, revoked: true });
        return { revoked: true };
      });
    }
    if (action === 'family.removeMember' || action === 'family.leave') {
      return scopedWrite(fid, uid, action === 'family.removeMember', async (tx, f) => {
        const target = action === 'family.leave' ? uid : string(p.userId, '成员 ID');
        const member = f.members.find((m) => m.userId === target);
        if (!member) fail('NOT_FOUND', '成员不存在');
        if (member.role === 'owner') fail('FORBIDDEN', '家庭创建者不能退出或被移除');
        const u = await tx.get('users', target);
        f.members = f.members.filter((m) => m.userId !== target);
        await tx.set('users', target, { ...u, familyIds: u.familyIds.filter((id) => id !== fid) });
        return { removed: true };
      });
    }
    if (action === 'pet.list' || action === 'diary.list') {
      await family(db, fid, uid);
      if (action === 'diary.list') await entity(db, 'pets', p.petId, fid);
      const limit = p.limit === undefined ? 10 : p.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) fail('INVALID', '分页大小无效');
      const after = p.after ? string(p.after, '分页游标') : '';
      const where = { familyId: fid, deletedAt: null };
      if (action === 'diary.list') where.petId = p.petId;
      const rows = await db.list(action === 'pet.list' ? 'pets' : 'diaries', where, after, limit);
      await family(db, fid, uid);
      return { items: rows.map(publicDoc), next: rows.length === limit ? rows[rows.length - 1]._id : '' };
    }
    if (action === 'diary.get') {
      await family(db, fid, uid);
      const d = await entity(db, 'diaries', p.id, fid);
      await entity(db, 'pets', d.petId, fid);
      return publicDoc(d);
    }
    if (action === 'pet.save' || action === 'pet.delete') {
      return scopedWrite(fid, uid, true, async (tx) => {
        const id = p.id ? string(p.id, '宠物 ID') : `p_${hash(uid, fid, string(p.clientId, '请求 ID')).slice(0, 40)}`;
        const old = p.id ? await entity(tx, 'pets', id, fid) : await tx.get('pets', id);
        if (!p.id && old) {
          if (old.deletedAt !== null) fail('CONFLICT', '该请求对应的宠物已删除');
          return publicDoc(old);
        }
        if (old) version(old, p.version);
        if (action === 'pet.delete') {
          if (!old) fail('NOT_FOUND', '宠物不存在');
          await tx.set('pets', id, { ...old, deletedAt: now(), version: old.version + 1 });
          return { deleted: true };
        }
        const pet = { _id: id, familyId: fid, name: string(p.name, '宠物名称', 40).trim(), species: string(p.species, '物种', 20),
          breed: string(p.breed || '', '品种', 60, true), birthday: date(p.birthday || '', true),
          avatar: p.avatar === undefined ? (old && old.avatar || '') : (p.avatar ? (await photoIds(tx, [p.avatar], fid))[0] : ''),
          avatarId: petAvatarId(p.avatarId === undefined && old && old.species === p.species ? old.avatarId : p.avatarId, p.species),
          createdBy: old ? old.createdBy : uid, createdAt: old ? old.createdAt : now(), updatedAt: now(), version: old ? old.version + 1 : 1, deletedAt: null };
        await tx.set('pets', id, pet);
        return publicDoc(pet);
      });
    }
    if (action === 'diary.save' || action === 'diary.delete') {
      return scopedWrite(fid, uid, false, async (tx, f) => {
        const id = p.id ? string(p.id, '日记 ID') : `d_${hash(uid, fid, string(p.clientId, '请求 ID')).slice(0, 40)}`;
        const old = p.id ? await entity(tx, 'diaries', id, fid) : await tx.get('diaries', id);
        if (!p.id && old) {
          if (old.deletedAt !== null) fail('CONFLICT', '该请求对应的日记已删除');
          return publicDoc(old);
        }
        if (old) {
          if (old.createdBy !== uid && !f.members.some((m) => m.userId === uid && m.role === 'owner')) fail('FORBIDDEN', '仅作者或家庭创建者可编辑这条日记');
          version(old, p.version);
          await entity(tx, 'pets', old.petId, fid);
        }
        if (action === 'diary.delete') {
          if (!old) fail('NOT_FOUND', '日记不存在');
          await tx.set('diaries', id, { ...old, deletedAt: now(), updatedBy: uid, version: old.version + 1, updatedAt: now() });
          return { deleted: true };
        }
        await entity(tx, 'pets', p.petId, fid);
        const output = await formatted(tx, p.formatted, fid);
        const original = old ? old.rawInput : await rawInput(tx, p.rawInput, fid);
        const mode = ['local', 'model', 'tool', 'manual', 'legacy'].includes(p.mode) ? p.mode : 'manual';
        const d = { _id: id, familyId: fid, petId: p.petId, rawInput: original, formatted: output,
          formatting: { schemaVersion: 1, mode }, createdBy: old ? old.createdBy : uid, updatedBy: uid,
          createdAt: old ? old.createdAt : now(), updatedAt: now(), version: old ? old.version + 1 : 1, deletedAt: null };
        await tx.set('diaries', id, d);
        return publicDoc(d);
      });
    }
    /*
     * 聊天会话：一话题一文档，按 (familyId, petId, userId) 隔离——
     * 对话是「我」和 AI 的工作台（待确认卡、上下文都是个人状态），不随家庭共享；
     * 最终产出（日记）才是家庭共享资产。
     */
    const sessionIndex = (s) => ({ id: s._id || s.id, title: s.title, summary: s.summary,
      messageCount: s.messageCount, startedAt: s.startedAt, updatedAt: s.updatedAt, version: s.version });
    async function sessionEntity(reader, id, familyId, petId, uid) {
      const s = await reader.get('chat_sessions', string(id, '会话 ID'));
      if (!s || s.familyId !== familyId || s.petId !== petId || s.userId !== uid || s.deletedAt !== null) fail('NOT_FOUND', '会话不存在');
      return s;
    }
    if (action === 'session.list') {
      await family(db, fid, uid);
      await entity(db, 'pets', p.petId, fid);
      const limit = p.limit === undefined ? 20 : p.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail('INVALID', '分页大小无效');
      const after = p.after ? string(p.after, '分页游标') : '';
      const rows = await db.list('chat_sessions', { familyId: fid, petId: p.petId, userId: uid, deletedAt: null }, after, limit);
      return { items: rows.map(sessionIndex), next: rows.length === limit ? rows[rows.length - 1]._id : '' };
    }
    if (action === 'session.get') {
      await family(db, fid, uid);
      await entity(db, 'pets', p.petId, fid);
      return publicDoc(await sessionEntity(db, p.id, fid, p.petId, uid));
    }
    if (action === 'session.save') {
      await family(db, fid, uid);
      await entity(db, 'pets', p.petId, fid);
      return db.transaction(async (tx) => {
        await family(tx, fid, uid);
        const id = p.id ? string(p.id, '会话 ID') : `cs_${hash(uid, fid, p.petId, string(p.clientId, '请求 ID')).slice(0, 40)}`;
        const old = p.id ? await sessionEntity(tx, id, fid, p.petId, uid) : await tx.get('chat_sessions', id);
        if (!p.id && old) {
          if (old.deletedAt !== null) fail('CONFLICT', '该请求对应的会话已删除');
          return publicDoc(old);
        }
        if (old) version(old, p.version);
        const messages = await sessionMessages(tx, p.messages, fid);
        const doc = {
          _id: id, familyId: fid, petId: p.petId, userId: uid,
          title: string(p.title || '', '会话标题', 40, true),
          summary: string(p.summary || '', '会话摘要', 120, true),
          messages, messageCount: messages.length,
          startedAt: old ? old.startedAt : now(), updatedAt: now(),
          version: old ? old.version + 1 : 1, deletedAt: null,
        };
        await tx.set('chat_sessions', id, doc);
        return publicDoc(doc);
      });
    }
    if (action === 'session.delete') {
      await family(db, fid, uid);
      return db.transaction(async (tx) => {
        await family(tx, fid, uid);
        const s = await sessionEntity(tx, p.id, fid, p.petId, uid);
        await tx.set('chat_sessions', s._id, { ...s, deletedAt: now(), version: s.version + 1, updatedAt: now() });
        return { deleted: true };
      });
    }
    if (action === 'media.upload') {
      await family(db, fid, uid);
      const encoded = string(p.base64, '照片数据', 1400000);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) fail('INVALID', '照片编码无效');
      const buffer = Buffer.from(encoded, 'base64');
      const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
      const png = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
      if (!buffer.length || buffer.length > 1024 * 1024 || (!jpeg && !png)) fail('INVALID', '请使用不超过 1MB 的 JPG 或 PNG 照片');
      const cloudPath = `families/${fid}/${uid}/${hash(buffer.toString('base64'))}.${jpeg ? 'jpg' : 'png'}`;
      const upload = await storage.uploadFile({ cloudPath, fileContent: buffer });
      // Storage is outside DB transactions. Identical uploads use the same path; failed DB writes leave an orphan for maintenance.
      return scopedWrite(fid, uid, false, async (tx) => {
        await tx.set('media', hash(upload.fileID), { fileId: upload.fileID, familyId: fid, uploadedBy: uid, createdAt: now() });
        return { fileId: upload.fileID };
      });
    }
    if (action === 'media.urls') {
      await family(db, fid, uid);
      const ids = await photoIds(db, p.fileIds, fid);
      if (!ids.length) return [];
      const result = await storage.getTempFileURL({ fileList: ids });
      await family(db, fid, uid);
      if (result.fileList.some((f) => f.status !== 0)) fail('MEDIA_UNAVAILABLE', '部分照片暂时无法读取');
      return result.fileList.map((f) => ({ fileId: f.fileID, url: f.tempFileURL }));
    }
    fail('INVALID', '不支持的操作');
  };
}
module.exports = { createService, hash };
