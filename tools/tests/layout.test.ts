import { measureLayout, resetViewport } from '../../utils/layout';

const originalWindow = wx.getWindowInfo;
beforeEach(() => jest.useFakeTimers());
afterEach(() => { wx.getWindowInfo = originalWindow; jest.useRealTimers(); });

test('112rpx 导航统一测量，安卓不重复加入安全区，iOS 保留安全区', () => {
  wx.getWindowInfo = () => ({ windowWidth: 375, windowHeight: 700, screenHeight: 800, safeArea: { bottom: 766 }, platform: 'android' }) as any;
  expect(measureLayout().tabbarHeight).toBe(56);
  wx.getWindowInfo = () => ({ windowWidth: 375, windowHeight: 700, screenHeight: 800, safeArea: { bottom: 766 }, platform: 'ios' }) as any;
  expect(measureLayout().tabbarHeight).toBe(90);
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
    expect(page.setData).toHaveBeenLastCalledWith({ tabbarHeight: 56, viewportHeight: 700 });
  } finally { wx.pageScrollTo = originalScroll; }
});
