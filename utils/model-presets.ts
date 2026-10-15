import { ModelConfig } from './store';

/** 首次接入与后续设置共用预设，避免入口之间漂移。 */
export const MODEL_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  DeepSeek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  'OpenAI 兼容': { baseUrl: '', model: '' },
  自定义: { baseUrl: '', model: '' },
};

export const MODEL_HELP = 'API Key 仅保存在本机，用于向你填写的模型服务发起请求，不同步到家庭空间。调用失败时会提示重试。';

export function modelPreset(provider: string) {
  return MODEL_PRESETS[provider] || { baseUrl: '', model: '' };
}

export function modelForm(config: ModelConfig): ModelConfig {
  const provider = config.provider || 'DeepSeek';
  const preset = modelPreset(provider);
  return { provider, baseUrl: config.baseUrl || preset.baseUrl, apiKey: config.apiKey, model: config.model || preset.model };
}

export function normalizeModelForm(config: ModelConfig): ModelConfig {
  return { ...config, baseUrl: config.baseUrl.trim(), apiKey: config.apiKey.trim(), model: config.model.trim() };
}
