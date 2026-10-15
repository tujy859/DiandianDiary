import { isDeveloperMode } from '../../utils/developer';
import { getCloudSession } from '../../utils/store';
import { callCloud } from '../../utils/cloud';
import { Family } from '../../utils/repository';
import { reconcileFamilyState } from '../../utils/family-state';
import { enterEmptyTestFamily, getNewUserTestState, isTestFamily, returnToOriginalFamily } from '../../utils/new-user-test';

Page({
  data: {
    allowed: false, busy: false, error: '', currentFamilyName: '', originalFamilyName: '',
    activeTest: false, canReturn: false,
  },

  async onShow() {
    const allowed = isDeveloperMode();
    this.setData({ allowed });
    if (!allowed) return;
    this.updateState();
    await this.run(async () => {
      const session = getCloudSession();
      if (!session) throw new Error('请先连接云端');
      const families = await callCloud<Family[]>('family.list');
      if (getCloudSession()?.userId !== session.userId || getCloudSession()?.familyId !== session.familyId) throw new Error('账号或家庭已切换，请重试');
      reconcileFamilyState(session.userId, families.map((family) => family.id));
      this.setData({ currentFamilyName: families.find((family) => family.id === session.familyId)?.name || '当前家庭不可用' });
    });
  },

  updateState() {
    const state = getNewUserTestState();
    const session = getCloudSession();
    this.setData({
      activeTest: isTestFamily(),
      originalFamilyName: state?.originalFamilyName || '',
      canReturn: !!state?.originalFamilyId && session?.familyId !== state.originalFamilyId,
    });
  },

  async run(work: () => Promise<void>) {
    if (this.data.busy || !isDeveloperMode()) return;
    this.setData({ busy: true, error: '' });
    try { await work(); }
    catch (err: any) { this.setData({ error: err.message || '操作失败，请重试' }); }
    finally { this.updateState(); this.setData({ busy: false }); }
  },

  onReplay() {
    if (this.data.busy || !isDeveloperMode()) return;
    wx.navigateTo({ url: '/pages/onboard/onboard?replay=1' });
  },

  onEnterEmpty() {
    return this.run(async () => {
      await enterEmptyTestFamily();
      wx.reLaunch({ url: '/pages/chat/chat' });
    });
  },

  onReturn() {
    return this.run(async () => {
      await returnToOriginalFamily();
      wx.reLaunch({ url: '/pages/mine/mine' });
    });
  },

  goFamily() { wx.navigateTo({ url: '/pages/family/family' }); },
});
