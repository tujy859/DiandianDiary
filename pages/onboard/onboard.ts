import Toast from 'tdesign-miniprogram/toast/index';
import { getModelConfig, saveModelConfig, getPets, getCloudSession } from '../../utils/store';
import { connectCloud, refreshCloudIfStale } from '../../utils/repository';
import { isModelReady, testConnection } from '../../utils/llm';
import { pendingStep } from '../../utils/onboard';
import { openAddPet } from '../../utils/pet-navigation';
import { MODEL_PRESETS, MODEL_HELP, modelPreset, modelForm, normalizeModelForm } from '../../utils/model-presets';
import { isDeveloperMode } from '../../utils/developer';

Page({
  data: {
    step: 'login' as 'login' | 'model',
    busy: false,
    testFailed: false,
    replay: false,
    hasSavedModel: false,
    error: '',
    providers: Object.keys(MODEL_PRESETS),
    modelHelp: MODEL_HELP,
    recommendedModel: MODEL_PRESETS.DeepSeek.model,
    form: { provider: 'DeepSeek', baseUrl: '', apiKey: '', model: '' },
  },

  onLoad(options: Record<string, string> = {}) {
    const saved = getModelConfig();
    const hasSavedModel = isModelReady(saved);
    // 演练必须有正常账号和配置；不借测试参数绕过真实使用前提。
    const replay = options.replay === '1' && isDeveloperMode() && !!getCloudSession() && hasSavedModel;
    const step = replay ? 'login' : pendingStep();
    const form = modelForm(replay ? { provider: '', baseUrl: '', apiKey: '', model: '' } : saved);
    this.setData({ replay, hasSavedModel, step: step || 'model', form, recommendedModel: modelPreset(form.provider).model });
    if (!step) {
      return this.finish();
    }
  },

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

  onSelectProvider(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const provider = e.currentTarget.dataset.value;
    const preset = modelPreset(provider);
    this.setData({
      recommendedModel: preset.model,
      testFailed: false,
      error: '',
      'form.provider': provider,
      'form.baseUrl': preset.baseUrl || this.data.form.baseUrl,
      'form.model': preset.model || this.data.form.model,
    });
  },

  onBaseUrl(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.baseUrl': e.detail.value, testFailed: false, error: '' }); },
  onApiKey(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.apiKey': e.detail.value, testFailed: false, error: '' }); },
  onModel(e: WechatMiniprogram.CustomEvent) { this.setData({ 'form.model': e.detail.value, testFailed: false, error: '' }); },

  onUseDefault() {
    if (this.data.busy) return;
    const preset = modelPreset(this.data.form.provider);
    if (!preset.baseUrl && !preset.model) {
      Toast({ context: this, selector: '#t-toast', message: '该服务商没有推荐默认值，请手动填写', theme: 'warning' });
      return;
    }
    this.setData({ 'form.baseUrl': preset.baseUrl, 'form.model': preset.model, testFailed: false, error: '' });
  },

  /** 第二步：保存配置并验证连通，失败也不阻断（可稍后在「我的」里改） */
  async onSaveModel() {
    if (this.data.busy) return;
    const form = normalizeModelForm(this.data.form);
    if (!isModelReady(form)) {
      Toast({ context: this, selector: '#t-toast', message: '请填好 Base URL、API Key 和模型', theme: 'warning' });
      return;
    }
    if (!this.data.replay) saveModelConfig(form);
    this.setData({ form, busy: true, error: '', testFailed: false });
    wx.showLoading({ title: '测试连接…', mask: true });
    try {
      await testConnection(form);
      wx.hideLoading();
      await this.finish();
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
    if (this.data.busy) return;
    return this.finish();
  },

  onUseSavedModel() {
    if (this.data.busy || !this.data.replay || !isModelReady(getModelConfig())) return;
    return this.finish();
  },

  onBackToTools() {
    if (!this.data.busy && this.data.replay) wx.redirectTo({ url: '/pages/new-user-test/new-user-test' });
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
