import Dialog from 'tdesign-miniprogram/dialog/index';
import { getCloudSession, setCloudSession, clearAll } from '../../utils/store';
import { connectCloud, selectFamily, importLocalData, refreshCloud, Family } from '../../utils/repository';
import { callCloud } from '../../utils/cloud';

Page({
  data: {
    connected: false, busy: false, error: '', userId: '', nickname: '', familyId: '',
    families: [] as Family[], members: [] as Array<{ userId: string; role: string; label: string }>,
    owner: false, familyName: '', inviteInput: '', inviteToken: '', inviteExpiry: '',
  },
  async onShow() {
    this.setData({ connected: false, families: [], members: [], userId: '', familyId: '', nickname: '', inviteToken: '' });
    if (getCloudSession()) await this.run(() => this.load());
  },
  async run(work: () => Promise<void>) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await work(); } catch (err: any) { this.setData({ error: err.message || '操作失败，请重试' }); }
    finally { this.setData({ busy: false }); }
  },
  async load() {
    const { user, families } = await connectCloud();
    const s = getCloudSession()!;
    const selected = families.find((f) => f.id === s.familyId)!;
    this.setData({ connected: true, userId: user.id, nickname: user.nickname, families,
      familyId: selected.id, owner: selected.members.some((m) => m.userId === user.id && m.role === 'owner'),
      members: selected.members.map((m, i) => ({ ...m, label: m.userId === user.id ? '我' : `成员 ${i + 1} · ${m.userId.slice(-6)}` })),
    });
    await refreshCloud();
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
    return this.run(async () => { await selectFamily(e.currentTarget.dataset.id); this.setData({ inviteToken: '' }); await this.load(); });
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
    Dialog.confirm({ context: this, selector: '#t-dialog', title: '退出这个家庭？', content: '退出后将无法继续查看家庭日记，你曾保存的日记会保留在家庭中。' })
      .then(() => this.run(async () => {
        await callCloud('family.leave', { familyId: this.data.familyId });
        clearAll();
        setCloudSession(null);
        await this.load();
      })).catch(() => {});
  },
  onImport() {
    const selected = this.data.families.find((f) => f.id === this.data.familyId);
    Dialog.confirm({ context: this, selector: '#t-dialog', title: '导入本机记录？',
      content: `本机宠物和日记将上传到「${selected?.name || ''}」，家庭成员都能看到。保留本机原数据，重复导入不会重复创建记录。聊天和模型密钥不会上传。` })
      .then(() => this.run(async () => {
        const count = await importLocalData();
        wx.showToast({ title: `已导入 ${count} 条日记`, icon: 'none' });
      })).catch(() => {});
  },
  onLocal() {
    if (this.data.busy) return;
    setCloudSession(null);
    this.setData({ connected: false, families: [], members: [], userId: '', familyId: '', inviteToken: '', error: '' });
  },
});
