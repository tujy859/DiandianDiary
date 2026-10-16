import Toast from 'tdesign-miniprogram/toast/index';
import Dialog from 'tdesign-miniprogram/dialog/index';
import { getModelConfig, saveModelConfig, clearModelConfig, ModelConfig } from '../../utils/store';
import { testConnection, isModelReady } from '../../utils/llm';
import { MODEL_PRESETS, MODEL_HELP, CLOUD_HELP, CLOUD_MODEL, MODEL_INPUT_STYLE, modelPreset, modelForm, normalizeModelForm, switchModelSource } from '../../utils/model-presets';
import { isCloudAiSupported, assertCloudAiAvailable, CLOUD_AI_MIN_SDK } from '../../utils/cloud-ai';

Page({
  _customModelDraft: undefined as ModelConfig | undefined,
  data: {
    providers: Object.keys(MODEL_PRESETS),
    modelHelp: MODEL_HELP,
    inputStyle: MODEL_INPUT_STYLE,
    cloudHelp: CLOUD_HELP,
    cloudModel: CLOUD_MODEL,
    minSdk: CLOUD_AI_MIN_SDK,
    cloudSupported: true,
    source: 'custom' as 'custom' | 'cloud',
    recommendedModel: MODEL_PRESETS.DeepSeek.model,
    connectionNote: '保存配置后生效，可以单独测试连接',
    form: { provider: 'DeepSeek', baseUrl: '', apiKey: '', model: '' },
    testing: false,
  },

  onLoad() {
    this._customModelDraft = undefined;
    const cfg = getModelConfig();
    const form = modelForm(cfg);
    this.setData({
      form,
      source: cfg.source === 'cloud' ? 'cloud' : 'custom',
      modelHelp: cfg.source === 'cloud' ? CLOUD_HELP : MODEL_HELP,
      cloudSupported: isCloudAiSupported(),
      recommendedModel: modelPreset(form.provider).model,
    });
  },

  onUnload() { this._customModelDraft = undefined; },

  /** 切换来源保留当前页面草稿，两套模型标识与请求凭证仍隔离。 */
  onSelectSource(e: WechatMiniprogram.TouchEvent) {
    if (this.data.testing) return;
    const source = e.currentTarget.dataset.source === 'cloud' ? 'cloud' : 'custom';
    if (source === this.data.source) return;
    const switched = switchModelSource(this.data.form, source, this._customModelDraft);
    const form = switched.form;
    this._customModelDraft = switched.customDraft;
    this.setData({
      source,
      form,
      modelHelp: source === 'cloud' ? CLOUD_HELP : MODEL_HELP,
      recommendedModel: source === 'cloud' ? '' : modelPreset(form.provider).model,
      connectionNote: '来源已切换，保存后生效',
    });
  },

  onSelectProvider(e: WechatMiniprogram.TouchEvent) {
    if (this.data.testing) return;
    const provider = e.currentTarget.dataset.value;
    const preset = modelPreset(provider);
    this.setData({
      recommendedModel: preset.model,
      connectionNote: '配置有改动，保存后生效',
      'form.provider': provider,
      'form.baseUrl': preset.baseUrl || this.data.form.baseUrl,
      'form.model': preset.model || this.data.form.model,
    });
  },

  onBaseUrl(e: WechatMiniprogram.CustomEvent) {
    this.setData({ 'form.baseUrl': e.detail.value, connectionNote: '配置有改动，保存后生效' });
  },

  onApiKey(e: WechatMiniprogram.CustomEvent) {
    this.setData({ 'form.apiKey': e.detail.value, connectionNote: '配置有改动，保存后生效' });
  },

  onModel(e: WechatMiniprogram.CustomEvent) {
    this.setData({ 'form.model': e.detail.value, connectionNote: '配置有改动，保存后生效' });
  },

  /** 一键填入服务商的推荐默认值（已保存的配置不会被预设覆盖，这里手动恢复） */
  onUseDefault() {
    if (this.data.testing) return;
    const preset = modelPreset(this.data.form.provider);
    if (!preset.baseUrl && !preset.model) {
      Toast({ context: this, selector: '#t-toast', message: '该服务商没有推荐默认值，请手动填写', theme: 'warning' });
      return;
    }
    this.setData({ 'form.baseUrl': preset.baseUrl, 'form.model': preset.model, connectionNote: '配置有改动，保存后生效' });
    Toast({ context: this, selector: '#t-toast', message: '已填入推荐默认值，记得保存', theme: 'success' });
  },

  onSave() {
    if (this.data.testing) return;
    const form = normalizeModelForm({ ...this.data.form, source: this.data.source });
    if (!isModelReady(form)) {
      Toast({ context: this, selector: '#t-toast', message: this.unreadyHint(), theme: 'warning' });
      return;
    }
    try { if (form.source === 'cloud') assertCloudAiAvailable(); } catch (err: any) {
      Toast({ context: this, selector: '#t-toast', message: err.message, theme: 'warning' });
      return;
    }
    saveModelConfig(form);
    this.setData({ form, connectionNote: '配置已保存；测试连接可确认是否可用' });
    Toast({ context: this, selector: '#t-toast', message: '配置已保存', theme: 'success' });
  },

  unreadyHint(): string {
    if (this.data.source === 'cloud') return '云开发 AI 当前不可用，请升级微信或改用自定义 API';
    return '请填好 Base URL、API Key 和模型';
  },

  /** 单独清除模型配置：API Key 属于敏感凭证，给一个明确的删除入口 */
  onClear() {
    if (this.data.testing) return;
    Dialog.confirm({
      context: this,
      selector: '#t-dialog',
      title: '清除模型配置？',
      content: this.data.source === 'cloud'
        ? '云开发 AI 配置会被删除，之后需要重新选择来源才能继续聊天。'
        : 'Base URL、API Key 和模型名都会被删除，之后需要重新配置才能继续聊天。',
      confirmBtn: { content: '清除', theme: 'danger' },
    }).then(() => {
      clearModelConfig();
      this._customModelDraft = undefined;
      this.setData({
        source: 'custom',
        modelHelp: MODEL_HELP,
        form: { provider: 'DeepSeek', baseUrl: MODEL_PRESETS.DeepSeek.baseUrl, apiKey: '', model: MODEL_PRESETS.DeepSeek.model },
        recommendedModel: MODEL_PRESETS.DeepSeek.model,
        connectionNote: '配置已清除，请重新填写后保存',
      });
      Toast({ context: this, selector: '#t-toast', message: '模型配置已清除', theme: 'success' });
    }).catch(() => {});
  },

  async onTest() {
    if (this.data.testing) return;
    const form = normalizeModelForm({ ...this.data.form, source: this.data.source });
    if (!isModelReady(form)) {
      Toast({ context: this, selector: '#t-toast', message: this.unreadyHint(), theme: 'warning' });
      return;
    }
    this.setData({ testing: true });
    wx.showLoading({ title: '测试连接…', mask: true });
    try {
      const reply = await testConnection(form);
      this.setData({ connectionNote: '当前填写的配置连接成功；如有改动，请保存' });
      wx.hideLoading();
      Dialog.alert({
        context: this,
        selector: '#t-dialog',
        title: '连接成功',
        content: `模型回复：${reply}`,
        confirmBtn: '好的',
      });
    } catch (err: any) {
      this.setData({ connectionNote: '连接失败，请检查网络与配置后重试' });
      wx.hideLoading();
      Dialog.alert({
        context: this,
        selector: '#t-dialog',
        title: '连接失败',
        content: (err && err.message) || (this.data.source === 'cloud'
          ? '请检查网络连接后重试'
          : '未知错误，请检查 Base URL 和 API Key'),
        confirmBtn: '知道了',
      });
    } finally {
      this.setData({ testing: false });
    }
  },
});
