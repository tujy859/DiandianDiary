/** Small authenticated transport; environment ID is public configuration, never a secret. */
import { cloudEnvironment } from './cloud-config';

export class CloudError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
let initialized = false;
/** 云函数与 AI 共用环境及一次初始化。 */
export function ensureCloud(): any {
  const cloud = (wx as any).cloud;
  if (!cloudEnvironment || !cloud) throw new CloudError('NOT_CONFIGURED', '请先配置云开发环境并部署 diaryApi 云函数');
  if (!initialized) {
    cloud.init({ env: cloudEnvironment, traceUser: false });
    initialized = true;
  }
  return cloud;
}
export async function callCloud<T>(action: string, data: unknown = {}): Promise<T> {
  const cloud = ensureCloud();
  const response = await cloud.callFunction({ name: 'diaryApi', data: { action, data } });
  const result = response.result;
  if (!result || result.ok !== true) throw new CloudError(result?.error?.code || 'NETWORK', result?.error?.message || '云端操作失败');
  return result.data as T;
}
