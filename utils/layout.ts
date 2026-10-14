/** Match the custom tab bar's 112rpx content and safe-area padding before it is measured. */
export function getLayout() {
  const info = wx.getWindowInfo ? wx.getWindowInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
  const width = info.windowWidth || 375;
  const safeBottom = info.safeArea ? Math.max(0, (info.screenHeight || info.safeArea.bottom) - info.safeArea.bottom) : 0;
  return { viewportHeight: info.windowHeight || 667, tabbarHeight: Math.ceil(width * 112 / 750 + safeBottom) };
}
