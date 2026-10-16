import { isDeveloperMode } from '../../utils/developer';
import { runCoreSelfChecks, SELF_CHECK_REFERENCE_DATE, SelfCheckResult } from '../../utils/self-check';
import { isTraceEnabled, setTraceEnabled, getDebugTraces, clearDebugTraces, debugReport } from '../../utils/debug-trace';
import { FlowRun, getFlowRun, prepareFlowRun, cleanupFlowRun, recoverFlowRun, openFlowRun } from '../../utils/flow-test';
import { diaryFlowSteps } from '../../utils/flow-scenarios';
import { getCloudSession, getCloudSessionEpoch } from '../../utils/store';
import { enterEmptyTestFamily, getNewUserTestState, isTestFamily, returnToOriginalFamily } from '../../utils/new-user-test';
import { callCloud } from '../../utils/cloud';
import { Family } from '../../utils/repository';
import { reconcileFamilyState } from '../../utils/family-state';

Page({
  data: {
    allowed: false, results: [] as SelfCheckResult[], passed: 0, failed: 0,
    running: false, lastRunAt: '', referenceDate: SELF_CHECK_REFERENCE_DATE,
    section: 'core', tracing: false, traceRows: [] as Array<{ id: string; status: string; durationMs: number; detail: string }>,
    flow: null as FlowRun | null, flowBusy: false, flowError: '', flowSteps: diaryFlowSteps(SELF_CHECK_REFERENCE_DATE),
    firstUseBusy: false, firstUseError: '', currentFamilyName: '', originalFamilyName: '', activeTest: false, canReturn: false,
  },

  onLoad(options: { section?: string }) {
    if (['start', 'core', 'flow', 'logs'].includes(options?.section || '')) this.setData({ section: options.section });
  },

  onShow() {
    this._viewEpoch = (this._viewEpoch || 0) + 1;
    this._flowPageActive = true;
    if (!isDeveloperMode()) {
      this.setData({ allowed: false, results: [], passed: 0, failed: 0, running: false, lastRunAt: '' });
      return;
    }
    this.setData({ allowed: true });
    if (this.data.section === 'start') return this.refreshFirstUse();
    if (this.data.section === 'core' && !this.data.lastRunAt) this.run();
    if (this.data.section === 'logs') this.refreshLogs();
    if (this.data.section === 'flow') this.refreshFlow();
  },
  onHide() { this._flowPageActive = false; this._viewEpoch++; this.setData({ firstUseBusy: false }); },
  onUnload() { this._flowPageActive = false; this._viewEpoch++; },

  onSection(e: WechatMiniprogram.TouchEvent) {
    if (!isDeveloperMode() || this.data.firstUseBusy || this.data.flowBusy) return;
    const section = e.currentTarget.dataset.section;
    if (!['start', 'core', 'flow', 'logs'].includes(section)) return;
    this.setData({ section });
    if (section === 'start') return this.refreshFirstUse();
    if (section === 'core' && !this.data.lastRunAt) this.run();
    if (section === 'logs') this.refreshLogs();
    if (section === 'flow') this.refreshFlow();
  },
  updateFirstUseState() {
    const state = getNewUserTestState();
    this.setData({ activeTest: isTestFamily(), originalFamilyName: state?.originalFamilyName || '',
      canReturn: !!state?.originalFamilyId && getCloudSession()?.familyId !== state.originalFamilyId });
  },
  async firstUseAction(work: (active: () => boolean) => Promise<void>) {
    if (!isDeveloperMode() || this.data.firstUseBusy) return;
    this.setData({ firstUseBusy: true, firstUseError: '' });
    const epoch = this._viewEpoch;
    const active = () => this._flowPageActive && this._viewEpoch === epoch && isDeveloperMode();
    try { await work(active); }
    catch (error: any) { if (active()) this.setData({ firstUseError: error.message || '操作失败，请重试' }); }
    finally { if (active()) { this.updateFirstUseState(); this.setData({ firstUseBusy: false }); } }
  },
  refreshFirstUse() {
    this.updateFirstUseState();
    return this.firstUseAction(async active => {
      const session = getCloudSession(), epoch = getCloudSessionEpoch();
      if (!session) throw new Error('请先连接云端');
      const families = await callCloud<Family[]>('family.list');
      if (!active() || epoch !== getCloudSessionEpoch()) return;
      reconcileFamilyState(session.userId, families.map(family => family.id));
      this.setData({ currentFamilyName: families.find(family => family.id === session.familyId)?.name || '当前家庭不可用' });
    });
  },
  onReplay() {
    if (isDeveloperMode() && !this.data.firstUseBusy) wx.navigateTo({ url: '/pages/onboard/onboard?replay=1' });
  },
  onEnterEmpty() {
    return this.firstUseAction(async active => {
      await enterEmptyTestFamily(active);
      if (active()) wx.reLaunch({ url: '/pages/chat/chat' });
    });
  },
  onReturn() {
    return this.firstUseAction(async active => {
      await returnToOriginalFamily();
      if (active()) wx.reLaunch({ url: '/pages/mine/mine' });
    });
  },
  goFamily() { wx.navigateTo({ url: '/pages/family/family' }); },
  refreshFlow() { if (isDeveloperMode()) this.setData({ flow: recoverFlowRun() }); },
  async onPrepareFlow() {
    if (!isDeveloperMode() || this.data.flowBusy) return;
    this.setData({ flowBusy: true, flowError: '' });
    try {
      await prepareFlowRun(() => this._flowPageActive);
      if (this._flowPageActive) wx.switchTab({ url: '/pages/chat/chat' });
    } catch (error: any) { this.setData({ flowError: error.message || '准备失败' }); }
    finally { this.setData({ flowBusy: false }); this.refreshFlow(); }
  },
  async onOpenFlow() {
    if (!isDeveloperMode() || this.data.flowBusy) return;
    const run = getFlowRun(); if (!run?.petId) return;
    this.setData({ flowBusy: true, flowError: '' });
    try {
      await openFlowRun(() => this._flowPageActive);
      if (!this._flowPageActive) return;
      if (getCloudSession()?.familyId !== run.familyId) throw new Error('本轮测试家庭已失效，请查看家庭管理');
      wx.switchTab({ url: '/pages/chat/chat' });
    } catch (error: any) { this.setData({ flowError: error.message || '打开失败' }); }
    finally { this.setData({ flowBusy: false }); this.refreshFlow(); }
  },
  onCleanupFlow() {
    if (!isDeveloperMode() || this.data.flowBusy) return;
    wx.showModal({ title: '清理本轮测试？', content: '清理本轮已知日记和专用测试宠物，保留测试家庭供下次复用。如需解散，请到「账号与家庭空间」操作。', success: async (result: any) => {
      if (!result.confirm || !this._flowPageActive || !isDeveloperMode() || this.data.flowBusy) return;
      this.setData({ flowBusy: true, flowError: '' });
      try { await cleanupFlowRun(() => this._flowPageActive); }
      catch (error: any) { this.setData({ flowError: error.message || '清理失败' }); }
      finally { this.setData({ flowBusy: false }); this.refreshFlow(); }
    } });
  },
  async onReturnFamily() {
    if (!isDeveloperMode() || this.data.flowBusy) return;
    this.setData({ flowBusy: true, flowError: '' });
    try { await returnToOriginalFamily(); if (this._flowPageActive) wx.reLaunch({ url: '/pages/mine/mine' }); }
    catch (error: any) { this.setData({ flowError: error.message || '返回失败' }); }
    finally { this.setData({ flowBusy: false }); }
  },
  refreshLogs() {
    if (!isDeveloperMode()) return;
    this.setData({ tracing: isTraceEnabled(), traceRows: getDebugTraces().slice().reverse().map(row => ({
      id: row.id, status: row.status, durationMs: row.durationMs,
      detail: row.events.map(e => `${new Date(e.at).toLocaleTimeString()} ${e.phase}\n${JSON.stringify(e.detail)}`).join('\n\n'),
    })) });
  },
  onToggleTrace() { setTraceEnabled(!isTraceEnabled()); this.refreshLogs(); },
  onRefreshLogs() { this.refreshLogs(); },
  onLogMore() {
    if (!isDeveloperMode() || this.data.section !== 'logs') return;
    const epoch = getCloudSessionEpoch(), viewEpoch = this._viewEpoch;
    wx.showActionSheet({ itemList: ['清空日志'], success: (result: any) => {
      if (result.tapIndex === 0 && isDeveloperMode() && this.data.section === 'logs'
        && getCloudSessionEpoch() === epoch && this._viewEpoch === viewEpoch) this.onClearLogs();
    } });
  },
  onClearLogs() { clearDebugTraces(); this.refreshLogs(); },
  onCopyLogs() { if (isDeveloperMode()) wx.setClipboardData({ data: debugReport() }); },
  onCopyTraceLogs(e: WechatMiniprogram.TouchEvent) {
    if (!isDeveloperMode()) return;
    const id = e.currentTarget.dataset.id;
    if (typeof id !== 'string' || !id) return;
    if (!getDebugTraces().some(row => row.id === id)) {
      wx.showToast({ title: '日志已清除或过期，请刷新', icon: 'none' });
      this.refreshLogs();
      return;
    }
    wx.setClipboardData({ data: debugReport(id) });
  },

  onRerun() { this.run(); },

  run() {
    if (!isDeveloperMode() || this.data.running) return;
    this.setData({ running: true });
    const results = runCoreSelfChecks();
    const passed = results.filter(result => result.pass).length;
    const d = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    this.setData({ results, passed, failed: results.length - passed, running: false,
      lastRunAt: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    });
  },
});
