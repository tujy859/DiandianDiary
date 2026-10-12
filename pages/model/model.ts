import Toast from 'tdesign-miniprogram/toast/index';
import Dialog from 'tdesign-miniprogram/dialog/index';
import { getModelConfig, saveModelConfig } from '../../utils/store';
import { testConnection, isModelReady } from '../../utils/llm';

const PRESET: Record<string, { baseUrl: string; model: string }> = {
  DeepSeek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  'OpenAI 兼容': { baseUrl: '', model: '' },
  自定义: { baseUrl: '', model: '' },
};

Page({
  data: {
    providers: Object.keys(PRESET),
    form: { provider: 'DeepSeek', baseUrl: '', apiKey: '', model: '' },
    testing: false,
  },

  onLoad() {
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

  onSelectProvider(e: WechatMiniprogram.TouchEvent) {
    const provider = e.currentTarget.dataset.value;
    const preset = PRESET[provider] || { baseUrl: '', model: '' };
    this.setData({
      'form.provider': provider,
      'form.baseUrl': preset.baseUrl || this.data.form.baseUrl,
      'form.model': preset.model || this.data.form.model,
    });
  },

  onBaseUrl(e: WechatMiniprogram.CustomEvent) {
    this.setData({ 'form.baseUrl': e.detail.value });
  },

  onApiKey(e: WechatMiniprogram.CustomEvent) {
    this.setData({ 'form.apiKey': e.detail.value });
  },

  onModel(e: WechatMiniprogram.CustomEvent) {
    this.setData({ 'form.model': e.detail.value });
  },

  /** 一键填入服务商的推荐默认值（已保存的配置不会被预设覆盖，这里手动恢复） */
  onUseDefault() {
    const preset = PRESET[this.data.form.provider] || { baseUrl: '', model: '' };
    if (!preset.baseUrl && !preset.model) {
      Toast({ context: this, selector: '#t-toast', message: '该服务商没有推荐默认值，请手动填写', theme: 'warning' });
      return;
    }
    this.setData({ 'form.baseUrl': preset.baseUrl, 'form.model': preset.model });
    Toast({ context: this, selector: '#t-toast', message: '已填入推荐默认值，记得保存', theme: 'success' });
  },

  onSave() {
    saveModelConfig(this.data.form);
    Toast({ context: this, selector: '#t-toast', message: '已保存，聊聊页将优先调用模型', theme: 'success' });
  },

  async onTest() {
    if (!isModelReady(this.data.form)) {
      Toast({ context: this, selector: '#t-toast', message: '请先填好 Base URL、API Key 和模型', theme: 'warning' });
      return;
    }
    this.setData({ testing: true });
    wx.showLoading({ title: '测试连接…', mask: true });
    try {
      const reply = await testConnection(this.data.form);
      wx.hideLoading();
      Dialog.alert({
        context: this,
        selector: '#t-dialog',
        title: '连接成功',
        content: `模型回复：${reply}`,
        confirmBtn: '好的',
      });
    } catch (err: any) {
      wx.hideLoading();
      Dialog.alert({
        context: this,
        selector: '#t-dialog',
        title: '连接失败',
        content: (err && err.message) || '未知错误，请检查 Base URL 和 API Key',
        confirmBtn: '知道了',
      });
    } finally {
      this.setData({ testing: false });
    }
  },
});
