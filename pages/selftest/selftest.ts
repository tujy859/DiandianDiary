import { isDeveloperMode } from '../../utils/developer';
import { runCoreSelfChecks, SELF_CHECK_REFERENCE_DATE, SelfCheckResult } from '../../utils/self-check';
import { isTraceEnabled, setTraceEnabled, getDebugTraces, clearDebugTraces, debugReport } from '../../utils/debug-trace';

Page({
  data: {
    allowed: false, results: [] as SelfCheckResult[], passed: 0, failed: 0,
    running: false, lastRunAt: '', referenceDate: SELF_CHECK_REFERENCE_DATE,
    section: 'core', tracing: false, traceRows: [] as Array<{ id: string; status: string; durationMs: number; detail: string }>,
  },

  onShow() {
    if (!isDeveloperMode()) {
      this.setData({ allowed: false, results: [], passed: 0, failed: 0, running: false, lastRunAt: '' });
      return;
    }
    this.setData({ allowed: true });
    if (!this.data.lastRunAt) this.run();
    if (this.data.section === 'logs') this.refreshLogs();
  },

  onSection(e: WechatMiniprogram.TouchEvent) {
    if (!isDeveloperMode()) return;
    const section = e.currentTarget.dataset.section;
    if (!['core', 'logs'].includes(section)) return;
    this.setData({ section });
    if (section === 'logs') this.refreshLogs();
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
