import { getCloudSession, setCloudSession, clearModelConfig } from './store';
import { reconcileFamilyState } from './family-state';

/** 本地退出，不调用家庭退出 / 解散，不删除云端数据或注销微信身份。 */
export function logoutLocal(clearModel = false): void {
  const session = getCloudSession();
  // 先失效身份与登录代次，迟到的刷新 / 同步不能恢复登录或缓存。
  setCloudSession(null);
  if (session) {
    reconcileFamilyState(session.userId, []);
    wx.removeStorageSync(`jd_new_user_test_${session.userId}`);
  }
  if (clearModel) clearModelConfig();
}
