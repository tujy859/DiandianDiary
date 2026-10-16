import { measureLayout, resetViewport } from '../../utils/layout';

const originalWindow = wx.getWindowInfo;
const originalComponent = (global as any).Component;
beforeEach(() => jest.useFakeTimers());
afterEach(() => { wx.getWindowInfo = originalWindow; (global as any).Component = originalComponent; jest.useRealTimers(); });

test('112rpx 导航另留 16px，安卓不重复加入安全区，iOS 叠加真实安全区', () => {
  wx.getWindowInfo = () => ({ windowWidth: 375, windowHeight: 700, screenHeight: 800, safeArea: { bottom: 766 }, platform: 'android' }) as any;
  expect(measureLayout()).toMatchObject({ tabbarHeight: 72, safeBottom: 0, tabbarBottomPadding: 16 });
  wx.getWindowInfo = () => ({ windowWidth: 375, windowHeight: 700, screenHeight: 800, safeArea: { bottom: 766 }, platform: 'ios' }) as any;
  expect(measureLayout()).toMatchObject({ tabbarHeight: 106, safeBottom: 34, tabbarBottomPadding: 50 });
});

test('键盘收起后同时恢复页面可视高度与导航占位', () => {
  const originalScroll = wx.pageScrollTo;
  (wx as any).pageScrollTo = jest.fn();
  const page = { setData: jest.fn() };
  let height = 400;
  wx.getWindowInfo = () => ({ windowWidth: 375, windowHeight: height, platform: 'android' }) as any;
  try {
    resetViewport(page);
    height = 700;
    jest.advanceTimersByTime(320);
    expect(page.setData).toHaveBeenLastCalledWith({ tabbarHeight: 72, viewportHeight: 700 });
  } finally { wx.pageScrollTo = originalScroll; }
});

test.each([320, 375, 414])('宽度 %s：导航组件与页面占位一致，安全区变化后更新底部留白', width => {
  let definition: any;
  (global as any).Component = value => { definition = value; };
  jest.isolateModules(() => require('../../custom-tab-bar/index.js'));
  const instance = { ...definition.methods, data: { ...definition.data }, setData(patch: any) { Object.assign(this.data, patch); } };
  for (const platform of ['android', 'ios']) {
    wx.getWindowInfo = () => ({ windowWidth: width, windowHeight: 700, screenHeight: 800, safeArea: { bottom: 766 }, platform }) as any;
    instance.applyLayout();
    const metrics = measureLayout();
    expect(instance.data.tabHeightStyle).toBe(`${metrics.tabbarHeight}px`);
    expect(instance.data.bottomPadding).toBe(platform === 'ios' ? 50 : 16);
    expect(metrics.tabbarHeight - instance.data.bottomPadding).toBeGreaterThanOrEqual(112 * width / 750);
  }
});
