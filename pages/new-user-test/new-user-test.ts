/** 兼容旧入口，开发工具统一到开发测试。 */
Page({
  onLoad() { wx.redirectTo({ url: '/pages/selftest/selftest?section=start' }); },
});
