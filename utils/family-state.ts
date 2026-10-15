import { getCloudSession, setCloudSession, clearModelConfig } from './store';

/** 本地退出与家庭缓存清理共用入口；不改变云端成员关系或数据。 */
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

/** 仅在云端确认家庭列表后清理失效缓存；网络失败不能冒充退出或解散。 */
export function reconcileFamilyState(userId: string, familyIds: string[]): void {
  const keys: string[] = wx.getStorageInfoSync().keys;
  for (const kind of ['cloud', 'chat', 'media', 'debug']) {
    const prefix = `jd_${kind}_${userId}_`;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const valid = familyIds.some((id) => kind === 'media'
        ? key === `${prefix}${id}` : key.startsWith(`${prefix}${id}_`));
      if (!valid) wx.removeStorageSync(key);
    }
  }
  pruneTestState(userId, (id) => familyIds.includes(id));
}

/** 明确失去一个家庭权限时仅清该家庭，不动仍可访问的空间。 */
export function forgetFamilyState(userId: string, familyId: string): void {
  const prefixes = ['cloud', 'chat', 'debug'].map((kind) => `jd_${kind}_${userId}_${familyId}_`);
  for (const key of wx.getStorageInfoSync().keys as string[]) {
    if (prefixes.some((prefix) => key.startsWith(prefix)) || key === `jd_media_${userId}_${familyId}`) wx.removeStorageSync(key);
  }
  pruneTestState(userId, (id) => id !== familyId);
}

function pruneTestState(userId: string, valid: (id: string) => boolean): void {
  const key = `jd_new_user_test_${userId}`;
  const state = wx.getStorageSync(key);
  if (!state) return;
  if (state.originalFamilyId && !valid(state.originalFamilyId)) {
    state.originalFamilyId = '';
    state.originalFamilyName = '';
  }
  if (state.testFamilyId && !valid(state.testFamilyId)) {
    state.testFamilyId = '';
    state.testFamilyName = '';
  }
  // 失去返回目标后不自动选一个新目标；下一次主动测试时再记录。
  if (!state.originalFamilyId && !state.testFamilyId && !state.pendingClientId) wx.removeStorageSync(key);
  else wx.setStorageSync(key, state);
}
