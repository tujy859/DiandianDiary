/** 微信云开发免密钥传输；保留模型的工具调用结构，供现有 agent 执行。 */
import { ensureCloud, CloudError } from './cloud';
import { AbortToken, AbortedError, throwIfAborted } from './cancellation';

// 沿用来源工作区为非资源点套餐选择的成长计划通道，不自动改用付费通道。
export const CLOUD_AI_PROVIDER = 'hunyuan-v3';
export const CLOUD_AI_MODEL = 'hy3';
export const CLOUD_AI_MIN_SDK = '3.15.1';
export const CLOUD_AI_TIMEOUT_MS = 45000;

export function compareVersion(a: string, b: string): number {
  const left = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const right = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function currentSdkVersion(): string {
  const runtime = wx as any;
  const info = runtime.getAppBaseInfo?.() || {};
  return String(info.SDKVersion || runtime.getSystemInfoSync?.()?.SDKVersion || '');
}

export function isCloudAiSupported(sdkVersion = currentSdkVersion()): boolean {
  return !!sdkVersion && compareVersion(sdkVersion, CLOUD_AI_MIN_SDK) >= 0;
}

/** 设置保存前也检查能力，避免把低版本或缺失的 API 保存成可用配置。 */
export function assertCloudAiAvailable(): any {
  if (!isCloudAiSupported()) {
    throw new CloudError('SDK_VERSION', `微信版本过低，云开发 AI 需要基础库 ${CLOUD_AI_MIN_SDK} 以上，请升级微信或改用自定义 API`);
  }
  const ai = ensureCloud().extend?.AI;
  if (typeof ai?.createModel !== 'function') {
    throw new CloudError('SDK_VERSION', '当前微信不支持云开发 AI，请升级微信或改用自定义 API');
  }
  return ai;
}

export function cloudAiRequest(payload: Record<string, any>, token?: AbortToken): Promise<any> {
  // 保持 Promise 拒绝语义，包括请求发起前的取消与能力检查失败。
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, data?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (token?.aborted) reject(new AbortedError());
      else if (error) reject(error);
      else resolve(data);
    };
    try {
      throwIfAborted(token);
      const ai = assertCloudAiAvailable();
      timer = setTimeout(() => finish(new CloudError('TIMEOUT', '云开发 AI 响应超时，请稍后重试')), CLOUD_AI_TIMEOUT_MS);
      if (token?.onAbort) unsubscribe = token.onAbort(() => finish(new AbortedError()));
      if (settled) return;
      const pending = ai.createModel(CLOUD_AI_PROVIDER).generateText({
        ...payload, model: payload.model || CLOUD_AI_MODEL, thinking: { type: 'disabled' },
      });
      // SDK 无 abort 句柄：本地立即停止等待，迟到成功和失败均被消费，不执行后续工具。
      Promise.resolve(pending).then((raw) => {
        if (settled) return;
        try { finish(undefined, normalizeCompletion(raw)); } catch (error) { finish(normalizeError(error)); }
      }, (error) => finish(normalizeError(error)));
    } catch (error) { finish(normalizeError(error)); }
  });
}

function normalizeCompletion(raw: any): any {
  if (raw?.error) throw normalizeError(raw.error);
  const msg = raw?.choices?.[0]?.message;
  if (msg && (typeof msg.content === 'string' && msg.content.trim()
    || Array.isArray(msg.tool_calls) && msg.tool_calls.length)) return raw;
  if (typeof raw?.text === 'string' && raw.text.trim()) {
    return { choices: [{ message: { role: 'assistant', content: raw.text } }], usage: raw.usage };
  }
  throw new CloudError('EMPTY', '云开发 AI 返回为空，请重试或改用自定义 API');
}

function normalizeError(error: any): Error {
  if (error instanceof CloudError || error instanceof AbortedError) return error;
  const message = [error?.code, error?.errCode, error?.message, error?.errMsg,
    typeof error === 'string' ? error : ''].filter(Boolean).join(' ') || '未知错误';
  if (/exceed[_ ]?concurrent/i.test(message)) return new CloudError('CONCURRENT', '使用人数较多，请稍后重试云开发 AI');
  if (/auth|登录|login|permission|无权限/i.test(message)) return new CloudError('AUTH', '云开发 AI 鉴权失败，请检查登录状态与云环境权限');
  if (/insufficient|quota|balance|额度|资源不足/i.test(message)) return new CloudError('QUOTA', '云开发 AI 额度不足，请检查控制台额度或改用自定义 API');
  if (/not[_ ]?open|未开通|not enabled/i.test(message)) return new CloudError('MODEL_CLOSED', '该模型尚未在云开发控制台开通或当前环境不可用');
  if (/response[_ -]?format|json_object/i.test(message) && /unsupported|not support|invalid|unknown|不支持|无效/i.test(message)) {
    return new CloudError('UNSUPPORTED_FORMAT', '当前云开发模型不支持请求的 JSON 输出格式');
  }
  if (/tools?|function[_ -]?calling/i.test(message) && /unsupported|not support|unknown|不支持/i.test(message)) {
    return new CloudError('UNSUPPORTED_TOOLS', '当前云开发模型不支持工具调用');
  }
  return new CloudError('CLOUD_AI', `云开发 AI 调用失败：${message}`);
}
