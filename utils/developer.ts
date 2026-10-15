const DEVELOPER_KEY = 'jd_developer_mode';

/** 仅控制本机开发工具入口，不作为云端权限依据。 */
export function isDeveloperMode(): boolean {
  return wx.getStorageSync(DEVELOPER_KEY) === true;
}

export function enableDeveloperMode(): void {
  wx.setStorageSync(DEVELOPER_KEY, true);
}
