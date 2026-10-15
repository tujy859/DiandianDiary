import Dialog from 'tdesign-miniprogram/dialog/index';
import { getCloudSession, getCloudSessionEpoch, setCloudSession } from '../../utils/store';
import { connectCloud, selectFamily, refreshCloud, Family } from '../../utils/repository';
import { callCloud } from '../../utils/cloud';
import { forgetFamilyState } from '../../utils/family-state';
import { logoutLocal } from '../../utils/auth';

Page({
  data: {
    connected: false, loggedIn: false, clearModelOnLogout: false, busy: false, error: '', userId: '', nickname: '', familyId: '',
    families: [] as Family[], members: [] as Array<{ userId: string; role: string; label: string; nickname?: string }>,
    owner: false, selectedFamilyName: '', familyName: '', inviteInput: '', inviteToken: '', inviteExpiry: '',
  },
  async onShow() {
    this.setData({ connected: false, loggedIn: !!getCloudSession(), families: [], members: [], userId: '', familyId: '', nickname: '', inviteToken: '', owner: false, selectedFamilyName: '' });
    if (getCloudSession()) await this.run(() => this.load());
  },
  async run(work: () => Promise<void>) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await work(); } catch (err: any) {
      if (getCloudSession()?.familyId !== this.data.familyId) {
        this.setData({ connected: false, families: [], members: [], familyId: '', selectedFamilyName: '', owner: false, inviteToken: '' });
      }
      this.setData({ error: err.message || '操作失败，请重试' });
    }
    finally { this.setData({ busy: false }); }
  },
  async load() {
    const { user, families } = await connectCloud();
    const s = getCloudSession()!;
    const selected = families.find((f) => f.id === s.familyId);
    this.setData({ connected: true, loggedIn: true, userId: user.id, nickname: user.nickname, families,
      familyId: selected?.id || '', selectedFamilyName: selected?.name || '',
      owner: !!selected?.members.some((m) => m.userId === user.id && m.role === 'owner'),
      // 昵称是展示用的首选；没设置昵称才退回「成员 N · 尾号」
    members: (selected?.members || []).map((m, i) => ({
      ...m,
      label: m.userId === user.id
        ? (user.nickname ? `我（${user.nickname}）` : '我')
        : (m.nickname || `成员 ${i + 1} · ${m.userId.slice(-6)}`),
    })),
    });
    if (selected) await refreshCloud();
  },
  onConnect() { return this.run(() => this.load()); },
  onNickname(e: WechatMiniprogram.CustomEvent) { this.setData({ nickname: e.detail.value }); },
  onSaveProfile() { return this.run(async () => { await callCloud('user.profile', { nickname: this.data.nickname }); }); },
  onFamilyName(e: WechatMiniprogram.CustomEvent) { this.setData({ familyName: e.detail.value }); },
  onInviteInput(e: WechatMiniprogram.CustomEvent) { this.setData({ inviteInput: e.detail.value.trim() }); },
  onCreate() {
    return this.run(async () => {
      if (!this._createId) this._createId = `family-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const f = await callCloud<Family>('family.create', { name: this.data.familyName, clientId: this._createId });
      this._createId = '';
      await selectFamily(f.id);
      this.setData({ familyName: '', inviteToken: '' });
      await this.load();
    });
  },
  onSwitch(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    if (!id || id === this.data.familyId) return;
    return this.run(async () => { await selectFamily(id); this.setData({ inviteToken: '' }); await this.load(); });
  },
  onInvite() {
    return this.run(async () => {
      const invite = await callCloud<{ token: string; expiresAt: number }>('invite.create', { familyId: this.data.familyId });
      this.setData({ inviteToken: invite.token, inviteExpiry: '24 小时内有效，仅限一人加入' });
    });
  },
  onCopy() { (wx as any).setClipboardData({ data: this.data.inviteToken }); },
  onRevoke() {
    return this.run(async () => {
      await callCloud('invite.revoke', { familyId: this.data.familyId, token: this.data.inviteToken });
      this.setData({ inviteToken: '', inviteExpiry: '' });
    });
  },
  onJoin() {
    return this.run(async () => {
      const f = await callCloud<Family>('invite.accept', { token: this.data.inviteInput });
      await selectFamily(f.id);
      this.setData({ inviteInput: '', inviteToken: '' });
      await this.load();
    });
  },
  onRemove(e: WechatMiniprogram.TouchEvent) {
    const userId = e.currentTarget.dataset.id;
    Dialog.confirm({ context: this, selector: '#t-dialog', title: '移除这位成员？', content: '移除后将无法继续查看或修改家庭数据，历史日记会保留。' })
      .then(() => this.run(async () => { await callCloud('family.removeMember', { familyId: this.data.familyId, userId }); await this.load(); })).catch(() => {});
  },
  onLeave() {
    if (this.data.owner || !this.data.familyId) return;
    return this.run(async () => {
      const target = { userId: this.data.userId, familyId: this.data.familyId };
      try {
        await Dialog.confirm({ context: this, selector: '#t-dialog', title: `退出「${this.data.selectedFamilyName}」？`,
          content: '仅你离开这个家庭。之后无法查看家庭数据，你曾保存的日记仍留在家庭中。', confirmBtn: { content: '退出家庭', theme: 'danger' } });
      } catch (_) { return; }
      this.assertTarget(target);
      await callCloud('family.leave', { familyId: target.familyId });
      this.afterDeparture(target);
    });
  },

  onDissolve() {
    if (!this.data.owner || !this.data.familyId) return;
    return this.run(async () => {
      const target = { userId: this.data.userId, familyId: this.data.familyId };
      const summary = await callCloud<{ name: string; revision: number; members: number; pets: number; diaries: number }>('family.summary', { familyId: target.familyId });
      this.assertTarget(target);
      try {
        await Dialog.confirm({ context: this, selector: '#t-dialog', title: `解散「${summary.name}」？`,
          content: `影响 ${summary.members} 位成员、${summary.pets} 只宠物和 ${summary.diaries} 条可见日记。所有成员将失去访问权限，旧邀请码失效，并释放家庭名额。云端数据暂时保留，不会永久删除；暂不支持恢复。`,
          confirmBtn: { content: '解散家庭', theme: 'danger' }, cancelBtn: '保留家庭' });
        if (summary.members > 1) await Dialog.confirm({ context: this, selector: '#t-dialog', title: '所有成员都会失去访问权限',
          content: `这会关闭整个「${summary.name}」，其他家人也无法再查看其中的宠物、日记和照片。请确认要解散整个家庭。`, confirmBtn: { content: '确认解散', theme: 'danger' }, cancelBtn: '保留家庭' });
      } catch (_) { return; }
      this.assertTarget(target);
      await callCloud('family.dissolve', { familyId: target.familyId, revision: summary.revision });
      this.afterDeparture(target);
    });
  },

  assertTarget(target: { userId: string; familyId: string }) {
    const current = getCloudSession();
    if (current?.userId !== target.userId || current.familyId !== target.familyId) throw new Error('账号或家庭已切换，请重新确认');
  },

  afterDeparture(target: { userId: string; familyId: string }) {
    forgetFamilyState(target.userId, target.familyId);
    const current = getCloudSession();
    if (current?.userId !== target.userId || current.familyId !== target.familyId) return;
    setCloudSession({ userId: target.userId, familyId: '' });
    // 重建页面栈，避免返回到已退出 / 解散空间的聊天与日记快照。
    wx.reLaunch({ url: '/pages/family/family' });
  },

  onContinue() {
    if (!this.data.busy && this.data.familyId) wx.reLaunch({ url: '/pages/mine/mine' });
  },

  onLogoutModelChange(e: WechatMiniprogram.CustomEvent) {
    if (!this.data.busy) this.setData({ clearModelOnLogout: !!e.detail.value });
  },

  onLogout() {
    if (!getCloudSession()) return;
    return this.run(async () => {
      const epoch = getCloudSessionEpoch();
      const clearModel = this.data.clearModelOnLogout;
      try {
        await Dialog.confirm({ context: this, selector: '#t-dialog', title: '退出登录？',
          content: `将清除当前账号在本机的登录状态、所有家庭缓存和聊天。云端宠物、日记和家庭成员关系保留。${clearModel ? '本机模型配置也会清除。' : '本机模型配置保留。'}再次连接仍使用当前微信身份。`,
          confirmBtn: { content: '退出登录', theme: 'danger' }, cancelBtn: '取消' });
      } catch (_) { return; }
      if (epoch !== getCloudSessionEpoch()) throw new Error('账号或家庭已切换，请重新确认');
      logoutLocal(clearModel);
      this.setData({ loggedIn: false, connected: false, families: [], members: [], userId: '', nickname: '', familyId: '', inviteToken: '', inviteInput: '', familyName: '', owner: false, selectedFamilyName: '' });
      wx.reLaunch({ url: '/pages/onboard/onboard' });
    });
  },
});
