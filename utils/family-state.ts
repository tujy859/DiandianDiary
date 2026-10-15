/** 仅在云端确认家庭列表后清理失效缓存；网络失败不能冒充退出或解散。 */
export function reconcileFamilyState(userId: string, familyIds: string[]): void {
  const keys: string[] = wx.getStorageInfoSync().keys;
  for (const kind of ['cloud', 'chat', 'media']) {
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
  const prefixes = ['cloud', 'chat'].map((kind) => `jd_${kind}_${userId}_${familyId}_`);
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
