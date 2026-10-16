import { ModelConfig } from './store';
import { CLOUD_AI_MODEL } from './cloud-ai';

/** 首次接入与后续设置共用预设，避免入口之间漂移。 */
export const MODEL_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  DeepSeek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  'OpenAI 兼容': { baseUrl: '', model: '' },
  自定义: { baseUrl: '', model: '' },
};

/** 默认使用混元，通道与模型统一维护在 cloud-ai。 */
export const CLOUD_SOURCE = '微信云开发 AI';
export const CLOUD_MODEL = CLOUD_AI_MODEL;
/** TDesign 支持的变量，直接作用于输入组件根节点，两个入口共用。 */
export const MODEL_INPUT_STYLE = '--td-input-vertical-padding:20rpx 0;--td-input-label-min-width:132rpx;--td-input-label-max-width:132rpx;--td-font-size-m:26rpx;--td-input-placeholder-text-font-size:26rpx;--td-spacer-2:20rpx;--td-input-label-text-color:var(--jd-text-2);--td-input-default-text-color:var(--jd-text-1)';

export const MODEL_HELP = 'API Key 仅保存在本机，用于向你填写的模型服务发起请求，不同步到家庭空间。调用失败时会提示重试。';
export const CLOUD_HELP = '无需填写地址和密钥。聊天文字与必要的历史记录会发送给微信云开发模型，模型选择仅保存在本机。使用前请确认云环境支持该通道及可用额度。';

export function modelPreset(provider: string) {
  return MODEL_PRESETS[provider] || { baseUrl: '', model: '' };
}

export function modelForm(config: ModelConfig): ModelConfig {
  if (config.source === 'cloud') {
    return { source: 'cloud', provider: CLOUD_SOURCE, baseUrl: '', apiKey: '', model: CLOUD_MODEL };
  }
  const provider = config.provider && config.provider !== CLOUD_SOURCE ? config.provider : 'DeepSeek';
  const preset = modelPreset(provider);
  return { source: 'custom', provider, baseUrl: config.baseUrl || preset.baseUrl, apiKey: config.apiKey, model: config.model || preset.model };
}

export function normalizeModelForm(config: ModelConfig): ModelConfig {
  if (config.source === 'cloud') {
    return { source: 'cloud', provider: CLOUD_SOURCE, baseUrl: '', apiKey: '', model: CLOUD_MODEL };
  }
  return { ...config, source: 'custom', baseUrl: config.baseUrl.trim(), apiKey: config.apiKey.trim(), model: config.model.trim() };
}

/** 页面内保留自定义草稿；云开发表单始终不携带自定义凭证。 */
export function switchModelSource(current: ModelConfig, source: 'custom' | 'cloud', customDraft?: ModelConfig) {
  const draft = current.source === 'cloud' ? customDraft : { ...current, source: 'custom' as const };
  const form = source === 'custom' && draft
    ? { ...draft }
    : modelForm({ source, provider: '', baseUrl: '', apiKey: '', model: '' });
  return { form, customDraft: draft };
}
