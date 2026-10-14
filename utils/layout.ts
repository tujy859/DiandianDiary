/**
 * 视图层公共度量。
 *
 * 修复背景：页面和自定义 tabBar 之前各自估算 tabBar 高度（聊聊兜底 60、时光册/我的兜底 80），
 * 再加上从「聊聊」带着软键盘切走时新页面会以被压缩的视口创建，
 * 于是切到「时光册」「我的」时底部总会冒出一块不该有的空白。
 * 这里把测量收敛到一处，并暴露 resetViewport 做兜底修复。
 */

export interface LayoutMetrics {
    /** 页面可视高度（px） */
    viewportHeight: number;
    /** 自定义 tabBar 占位高度（px，已含底部安全区） */
    tabbarHeight: number;
    /** 底部安全区高度（px） */
    safeBottom: number;
    /** rpx → px 换算比例 */
    rpxRatio: number;
}

/** tabBar 内容高度（rpx），与 custom-tab-bar/index.wxss 保持一致 */
const TABBAR_CONTENT_RPX = 112;

let cache: LayoutMetrics | null = null;

function readWindowInfo(): any {
    try {
        if (typeof wx.getWindowInfo === 'function') return wx.getWindowInfo();
    } catch (err) {
        // 低版本基础库回退
    }
    try {
        return wx.getSystemInfoSync();
    } catch (err) {
        return {};
    }
}

export function measureLayout(): LayoutMetrics {
    const win = readWindowInfo();
    const windowWidth = win.windowWidth || 375;
    const screenHeight = win.screenHeight || win.windowHeight || 667;
    const platform = String(win.platform || '').toLowerCase();
    const isIOS = platform === 'ios' || /ios/i.test(String(win.system || ''));
    const safeArea = win.safeArea;
    /**
     * 只有 iOS 需要额外补一段底部安全区。
     * 安卓/鸿蒙上 windowHeight 已经是可用视口高度，再补一次会把 tabBar 撑高几十像素，
     * 表现就是底部多出一块白色矩形（用户反馈的"白框"）。
     */
    const rawBottom = isIOS && safeArea && typeof safeArea.bottom === 'number'
        ? screenHeight - safeArea.bottom
        : 0;
    const safeBottom = Math.max(0, Math.min(60, rawBottom));
    const rpxRatio = windowWidth / 750;
    return {
        viewportHeight: win.windowHeight || screenHeight,
        tabbarHeight: Math.ceil(TABBAR_CONTENT_RPX * rpxRatio + safeBottom),
        safeBottom,
        rpxRatio,
    };
}

/** 取布局参数；refresh=true 时重新测量（键盘收起、旋转屏后缓存必须失效）。 */
export function getLayout(refresh = false): LayoutMetrics {
    if (refresh || !cache) {
        cache = measureLayout();
        const app: any = getApp();
        if (app && app.globalData) {
            app.globalData.layout = cache;
            // 兼容旧字段
            app.globalData.tabbarHeight = cache.tabbarHeight;
        }
    }
    return cache;
}

/**
 * 兜底修复：从带键盘的页面切过来时，新页面的视口可能仍停留在被压缩的高度，
 * 表现为 tabBar 不贴底、下方多出一整块空白。这里把滚动位置归零并重新测量。
 */
export function resetViewport(page?: { setData: (data: any) => void }) {
    const apply = () => {
        wx.pageScrollTo({ scrollTop: 0, duration: 0, fail: () => { } });
        const layout = getLayout(true);
        if (page && layout.tabbarHeight !== undefined) {
            page.setData({ tabbarHeight: layout.tabbarHeight, viewportHeight: layout.viewportHeight });
        }
    };
    try {
        wx.hideKeyboard({ complete: () => { } });
    } catch (err) { /* 忽略：部分环境无键盘 */ }
    apply();
    // 键盘收起动画约 250ms，结束后再校正一次，确保视口已经恢复
    setTimeout(apply, 320);
}
