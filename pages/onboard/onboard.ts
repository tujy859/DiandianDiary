import Toast from 'tdesign-miniprogram/toast/index';
import { getModelConfig, saveModelConfig } from '../../utils/store';
import { connectCloud } from '../../utils/repository';
import { isModelReady, testConnection } from '../../utils/llm';
import { pendingStep } from '../../utils/onboard';

const PRESET: Record<string, { baseUrl: string; model: string }> = {
  DeepSeek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  'OpenAI 兼容': { baseUrl: '', model: '' },
  自定义: { baseUrl: '', model: '' },
};

Page({
  data: {
    step: 'login' as 'login' | 'model',
    busy: false,
    testFailed: false,
    error: '',
    providers: Object.keys(PRESET),
    form: { provider: 'DeepSeek', baseUrl: '', apiKey: '', model: '' },
  },

  onLoad() {
    // 已就绪时直接回聊聊页，避免停留在引导页
    const step = pendingStep();
    if (!step) {
      this.finish();
      return;
    }
    this.setData({ step });
    const cfg = getModelConfig();
    this.setData({
      form: {
        provider: cfg.provider || 'DeepSeek',
        baseUrl: cfg.baseUrl || PRESET.DeepSeek.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model || PRESET.DeepSeek.model,
      },
    });
  },

  /** 第一步：微信身份静默登录，成功后根据是否已有模型配置决定下一步 */
  async onStart() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await connectCloud();
      if (!isModelReady(getModelConfig())) {
        this.setData({ busy: false, step: 'model' });
        return;
      }
      this.finish();
    } catch (err: any) {
      this.setData({ busy: false, error: err.message || '连接失败，请检查网络后重试' });
    }
  },

  onSelectProvider(e: WechatMiniprogram.TouchEvent) {
    const provider = e.currentTarget.dataset.value;
    const preset = PRESET[provider] || { baseUrl: '', model: '' };
    this.setData({
      'form.provider': provider,
      'form.baseUrl': preset.baseUrl || this.data.form.baseUrl,
      'form.model': preset.model || this.data.form.model,
    });
  },

  onBaseUrl(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.baseUrl': e.detail.value }); },
  onApiKey(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.apiKey': e.detail.value }); },
  onModel(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.model': e.detail.value }); },

  onUseDefault() {
    const preset = PRESET[this.data.form.provider] || { baseUrl: '', model: '' };
    if (!preset.baseUrl && !preset.model) {
      Toast({ context: this, selector: '#t-toast', message: '该服务商没有推荐默认值，请手动填写', theme: 'warning' });
      return;
    }
    this.setData({ 'form.baseUrl': preset.baseUrl, 'form.model': preset.model });
  },

  /** 第二步：保存配置并验证连通，失败也不阻断（可稍后在「我的」里改） */
  async onSaveModel() {
    if (this.data.busy) return;
    const form = this.data.form;
    if (!isModelReady(form)) {
      Toast({ context: this, selector: '#t-toast', message: '请填好 Base URL、API Key 和模型', theme: 'warning' });
      return;
    }
    saveModelConfig(form);
    this.setData({ busy: true, error: '', testFailed: false });
    wx.showLoading({ title: '测试连接…', mask: true });
    try {
      await testConnection(form);
      wx.hideLoading();
      this.finish();
    } catch (err: any) {
      wx.hideLoading();
      this.setData({
        busy: false,
        testFailed: true,
        error: (err && err.message) || '连接失败，请检查 Base URL 和 API Key',
      });
    }
  },

  /** 测试失败但用户想先进入：配置已保存，之后在「我的 → 模型连接配置」可改 */
  onSkip() {
    this.finish();
  },

  finish() {
    wx.switchTab({ url: '/pages/chat/chat' });
  },
});
