import { isTestFamily } from '../../utils/new-user-test';
import { isDeveloperMode } from '../../utils/developer';

Component({
  data: { active: false },
  lifetimes: { attached() { this.setData({ active: isTestFamily() }); } },
  pageLifetimes: { show() { this.setData({ active: isTestFamily() }); } },
  methods: {
    onManage() {
      wx.navigateTo({ url: isDeveloperMode() ? '/pages/selftest/selftest?section=start' : '/pages/family/family' });
    },
  },
});
