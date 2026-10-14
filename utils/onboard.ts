/**
 * 引导守卫：登录 + 模型配置是使用前的两个必要条件。
 * 两台设备/换设备后需要重新配置 API Key（Key 只存在本机，不同步到云端）。
 */
import { getCloudSession, getModelConfig } from './store';
import { isModelReady } from './llm';

export type OnboardStep = 'login' | 'model';

/** 未完成的前置步骤；null 表示已就绪 */
export function pendingStep(): OnboardStep | null {
  if (!getCloudSession()) return 'login';
  if (!isModelReady(getModelConfig())) return 'model';
  return null;
}

let navigateAt = 0;
/** tab 页入口守卫：未就绪就跳引导页，返回 true 表示可以继续渲染当前页 */
export function guardReady(): boolean {
  if (!pendingStep()) return true;
  // onShow 会高频触发（切 tab、引导页返回），短时间内不重复跳转
  if (Date.now() - navigateAt < 1500) return false;
  navigateAt = Date.now();
  wx.navigateTo({ url: '/pages/onboard/onboard' });
  return false;
}
