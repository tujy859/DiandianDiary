/**
 * 断网感知：启动时探测一次，之后靠系统事件实时更新。
 * 页面据此分级提示——常驻提示条、发送拦截、引导页说明，不做全屏阻塞。
 */
let offline = false;
let watching = false;
const listeners: Array<(offline: boolean) => void> = [];

function setOffline(next: boolean) {
  if (next === offline) return;
  offline = next;
  listeners.slice().forEach((cb) => cb(offline));
}

export function initNetworkWatch(): void {
  if (watching) return;
  watching = true;
  try {
    wx.getNetworkType({
      success: (res: any) => setOffline(res.networkType === 'none'),
      fail: () => setOffline(false), // 探测不到时不假设离线，避免误伤
    });
    wx.onNetworkStatusChange((res: any) => setOffline(res.isConnected === false));
  } catch (e) { /* 极少数环境没有该能力，忽略 */ }
}

export function isOffline(): boolean {
  return offline;
}

export function watchNetwork(cb: (offline: boolean) => void): () => void {
  initNetworkWatch(); // 第一个监听者出现时才开始探测，无需依赖 app 生命周期
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}
