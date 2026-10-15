import { isDeveloperMode } from '../../utils/developer';
import { runCoreSelfChecks, SELF_CHECK_REFERENCE_DATE, SelfCheckResult } from '../../utils/self-check';
import { isTraceEnabled, setTraceEnabled, getDebugTraces, clearDebugTraces, debugReport } from '../../utils/debug-trace';
import { FlowRun, getFlowRun, prepareFlowRun, cleanupFlowRun, recoverFlowRun, openFlowRun } from '../../utils/flow-test';
import { diaryFlowSteps } from '../../utils/flow-scenarios';
import { getCloudSession } from '../../utils/store';
import { returnToOriginalFamily } from '../../utils/new-user-test';

Page({
  data: {
    allowed: false, results: [] as SelfCheckResult[], passed: 0, failed: 0,
    running: false, lastRunAt: '', referenceDate: SELF_CHECK_REFERENCE_DATE,
    section: 'core', tracing: false, traceRows: [] as Array<{ id: string; status: string; durationMs: number; detail: string }>,
    flow: null as FlowRun | null, flowBusy: false, flowError: '', flowSteps: diaryFlowSteps(SELF_CHECK_REFERENCE_DATE),
  },

  onLoad(options: { section?: string }) {
    if (['flow', 'logs'].includes(options?.section || '')) this.setData({ section: options.section });
  },

  onShow() {
    this._flowPageActive = true;
    if (!isDeveloperMode()) {
      this.setData({ allowed: false, results: [], passed: 0, failed: 0, running: false, lastRunAt: '' });
      return;
    }
    this.setData({ allowed: true });
    if (!this.data.lastRunAt) this.run();
    if (this.data.section === 'logs') this.refreshLogs();
    if (this.data.section === 'flow') this.refreshFlow();
  },
  onHide() { this._flowPageActive = false; },
  onUnload() { this._flowPageActive = false; },

  onSection(e: WechatMiniprogram.TouchEvent) {
    if (!isDeveloperMode()) return;
    const section = e.currentTarget.dataset.section;
    if (!['core', 'flow', 'logs'].includes(section)) return;
    this.setData({ section });
    if (section === 'logs') this.refreshLogs();
    if (section === 'flow') this.refreshFlow();
  },
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
    wx.showModal({ title: '清理本轮测试？', content: '仅清理本轮已知日记和专用测试宠物；其他家庭与记录保留。', success: async (result: any) => {
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
  onClearLogs() { clearDebugTraces(); this.refreshLogs(); },
  onCopyLogs() { if (isDeveloperMode()) wx.setClipboardData({ data: debugReport() }); },

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
