import { isDeveloperMode } from '../../utils/developer';
import { runCoreSelfChecks, SELF_CHECK_REFERENCE_DATE, SelfCheckResult } from '../../utils/self-check';

Page({
  data: {
    allowed: false, results: [] as SelfCheckResult[], passed: 0, failed: 0,
    running: false, lastRunAt: '', referenceDate: SELF_CHECK_REFERENCE_DATE,
  },

  onShow() {
    if (!isDeveloperMode()) {
      this.setData({ allowed: false, results: [], passed: 0, failed: 0, running: false, lastRunAt: '' });
      return;
    }
    this.setData({ allowed: true });
    if (!this.data.lastRunAt) this.run();
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
