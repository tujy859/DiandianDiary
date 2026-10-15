import { isTestFamily } from '../../utils/new-user-test';

Component({
  data: { active: false },
  lifetimes: { attached() { this.setData({ active: isTestFamily() }); } },
  pageLifetimes: { show() { this.setData({ active: isTestFamily() }); } },
  methods: {
    onManage() { wx.navigateTo({ url: '/pages/new-user-test/new-user-test' }); },
  },
});
