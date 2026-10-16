import Toast from 'tdesign-miniprogram/toast/index';
import { getModelConfig, saveModelConfig, getPets, getCloudSession, ModelConfig } from '../../utils/store';
import { connectCloud, refreshCloudIfStale } from '../../utils/repository';
import { isModelReady, testConnection } from '../../utils/llm';
import { pendingStep } from '../../utils/onboard';
import { openAddPet } from '../../utils/pet-navigation';
import { MODEL_PRESETS, MODEL_HELP, CLOUD_HELP, CLOUD_MODEL, MODEL_INPUT_STYLE, modelPreset, modelForm, normalizeModelForm, switchModelSource } from '../../utils/model-presets';
import { isCloudAiSupported, assertCloudAiAvailable, CLOUD_AI_MIN_SDK } from '../../utils/cloud-ai';
import { isDeveloperMode } from '../../utils/developer';

Page({
  _customModelDraft: undefined as ModelConfig | undefined,
  data: {
    step: 'login' as 'login' | 'model',
    busy: false,
    testingModel: false,
    modelTest: 'idle' as 'idle' | 'success' | 'failed',
    replay: false,
    hasSavedModel: false,
    error: '',
    providers: Object.keys(MODEL_PRESETS),
    modelHelp: MODEL_HELP,
    inputStyle: MODEL_INPUT_STYLE,
    source: 'custom' as 'custom' | 'cloud',
    cloudModel: CLOUD_MODEL,
    minSdk: CLOUD_AI_MIN_SDK,
    cloudSupported: true,
    recommendedModel: MODEL_PRESETS.DeepSeek.model,
    form: { provider: 'DeepSeek', baseUrl: '', apiKey: '', model: '' },
  },

  onLoad(options: Record<string, string> = {}) {
    this._customModelDraft = undefined;
    const saved = getModelConfig();
    const hasSavedModel = isModelReady(saved);
    // 演练必须有正常账号和配置；不借测试参数绕过真实使用前提。
    const replay = options.replay === '1' && isDeveloperMode() && !!getCloudSession() && hasSavedModel;
    const step = replay ? 'login' : pendingStep();
    const form = modelForm(saved);
    this.setData({ replay, hasSavedModel, step: step || 'model', form,
      source: form.source, cloudSupported: isCloudAiSupported(),
      modelHelp: form.source === 'cloud' ? CLOUD_HELP : MODEL_HELP,
      recommendedModel: form.source === 'cloud' ? '' : modelPreset(form.provider).model });
    if (!step) {
      return this.finish();
    }
  },

  onUnload() { this._customModelDraft = undefined; },

  /** 第一步：微信身份静默登录，成功后根据是否已有模型配置决定下一步 */
  async onStart() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await connectCloud();
      if (this.data.replay || !isModelReady(getModelConfig())) {
        this.setData({ busy: false, step: 'model' });
        return;
      }
      await this.finish();
    } catch (err: any) {
      this.setData({ busy: false, error: err.message || '连接失败，请检查网络后重试' });
    }
  },

  onSelectSource(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const source = e.currentTarget.dataset.source === 'cloud' ? 'cloud' : 'custom';
    if (source === this.data.source) return;
    const switched = switchModelSource(this.data.form, source, this._customModelDraft);
    const form = switched.form;
    this._customModelDraft = switched.customDraft;
    this.setData({ source, form, modelHelp: source === 'cloud' ? CLOUD_HELP : MODEL_HELP,
      recommendedModel: source === 'cloud' ? '' : modelPreset(form.provider).model,
      error: '', modelTest: 'idle' });
  },

  onSelectProvider(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const provider = e.currentTarget.dataset.value;
    const preset = modelPreset(provider);
    this.setData({
      recommendedModel: preset.model,
      modelTest: 'idle',
      error: '',
      'form.provider': provider,
      'form.baseUrl': preset.baseUrl || this.data.form.baseUrl,
      'form.model': preset.model || this.data.form.model,
    });
  },

  onBaseUrl(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.baseUrl': e.detail.value, modelTest: 'idle', error: '' }); },
  onApiKey(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.apiKey': e.detail.value, modelTest: 'idle', error: '' }); },
  onModel(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.model': e.detail.value, modelTest: 'idle', error: '' }); },

  onUseDefault() {
    if (this.data.busy) return;
    const preset = modelPreset(this.data.form.provider);
    if (!preset.baseUrl && !preset.model) {
      Toast({ context: this, selector: '#t-toast', message: '该服务商没有推荐默认值，请手动填写', theme: 'warning' });
      return;
    }
    this.setData({ 'form.baseUrl': preset.baseUrl, 'form.model': preset.model, modelTest: 'idle', error: '' });
  },

  readyModelForm() {
    const form = normalizeModelForm({ ...this.data.form, source: this.data.source });
    if (!isModelReady(form)) {
      Toast({ context: this, selector: '#t-toast', message: '请填好 Base URL、API Key 和模型', theme: 'warning' });
      return;
    }
    try { if (form.source === 'cloud') assertCloudAiAvailable(); } catch (err: any) {
      this.setData({ error: err.message, modelTest: 'idle' });
      return;
    }
    return form;
  },

  /** 测试仅请求当前表单，不保存配置，也不跳页。 */
  async onTestModel() {
    if (this.data.busy) return;
    const form = this.readyModelForm();
    if (!form) return;
    this.setData({ form, busy: true, testingModel: true, error: '', modelTest: 'idle' });
    wx.showLoading({ title: '测试连接…', mask: true });
    try {
      await testConnection(form);
      this.setData({ modelTest: 'success' });
    } catch (err: any) {
      this.setData({
        modelTest: 'failed',
        error: (err && err.message) || (form.source === 'cloud' ? '云开发 AI 连接失败，请检查网络与云环境' : '连接失败，请检查 Base URL 和 API Key'),
      });
    } finally { wx.hideLoading(); this.setData({ busy: false, testingModel: false }); }
  },

  /** 确认时才保存；演练仅结束当前体验，正式配置保留。 */
  onConfirmModel() {
    if (this.data.busy) return;
    if (!this.data.replay) {
      const form = this.readyModelForm();
      if (!form) return;
      saveModelConfig(form);
      this.setData({ form });
    }
    return this.finish();
  },

  onBackToTools() {
    if (!this.data.busy && this.data.replay) wx.redirectTo({ url: '/pages/selftest/selftest?section=start' });
  },

  async finish() {
    this.setData({ busy: true, error: '' });
    try {
      if (getCloudSession() && !getCloudSession()!.familyId) {
        this.setData({ busy: false });
        wx.redirectTo({ url: '/pages/family/family' });
        return;
      }
      // 先确认家庭中是否已有宠物，换设备时不能按空缓存误开创建表单。
      await refreshCloudIfStale(0);
      if (!getPets().length) openAddPet();
      else wx.switchTab({ url: '/pages/chat/chat' });
      this.setData({ busy: false });
    } catch (err: any) {
      this.setData({ busy: false, error: err.message || '家庭空间读取失败，请重试' });
    }
  },
});
