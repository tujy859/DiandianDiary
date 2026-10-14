import { petAvatar, avatarIdFor, avatarOptions } from '../../utils/pet-avatars';
import Dialog from 'tdesign-miniprogram/dialog/index';
import Toast from 'tdesign-miniprogram/toast/index';
import { getPets, clearAll, getModelConfig, Pet, getCloudSession, getCloudCacheRevision, uid } from '../../utils/store';
import { savePet, removePet, refreshCloudIfStale } from '../../utils/repository';
import { isModelReady } from '../../utils/llm';
import { displayDate, fmt } from '../../utils/date';
import { getLayout, resetViewport } from '../../utils/layout';
import { guardReady } from '../../utils/onboard';

const SPECIES = ['猫', '狗', '其他'];

Page({
  data: {
    pets: [] as Array<Pet & { avatar: string; birthdayText?: string }>,
    formVisible: false,
    form: { id: '', name: '', species: '猫', breed: '', birthday: '', avatarId: 'cat-cream-orange' },
    avatarChoices: avatarOptions('猫'),
    speciesOptions: SPECIES,
    birthdayText: '',
    dateVisible: false,
    dateValue: 0,
    formError: '',
    modelNote: '未接入',
    devMode: false,
    aboutTaps: 0,
    tabbarHeight: 60,
    cloudOn: false,
  },

  async onShow() {
    // 收起键盘并重新测量布局，保留原有视口修复。
    resetViewport(this);
    if (!guardReady()) return;
    // 缓存优先渲染；后台节流刷新，只有数据真的变化才重渲染
    const revision = getCloudCacheRevision();
    this.setData({ cloudOn: !!getCloudSession(), tabbarHeight: getLayout(true).tabbarHeight });
    this.reload();
    this.setData({ modelNote: isModelReady(getModelConfig()) ? '已接入' : '未接入' });
    const tabbar = this.getTabBar && this.getTabBar();
    if (tabbar) tabbar.setData({ selected: 2 });
    if (!getCloudSession()) return;
    try {
      const refreshed = await refreshCloudIfStale();
      if (refreshed && getCloudCacheRevision() !== revision) this.reload();
    } catch (err: any) {
      Toast({ context: this, selector: '#t-toast', message: err.message || '云端读取失败', theme: 'error' });
    }
  },

  reload() {
    const pets = getPets().map((p) => ({
      ...p,
      avatar: petAvatar(p),
      birthdayText: p.birthday ? displayDate(p.birthday) : '',
    }));
    this.setData({ pets });
  },

  /* ---------- 宠物表单 ---------- */

  onAddPet() {
    this._petCreateId = uid();
    this.setData({
      formVisible: true,
      form: { id: '', name: '', species: '猫', breed: '', birthday: '', avatarId: 'cat-cream-orange' },
      avatarChoices: avatarOptions('猫'),
      birthdayText: '',
      formError: '',
    });
  },

  onEditPet(e: WechatMiniprogram.TouchEvent) {
    const pet = this.data.pets.find((p) => p.id === e.currentTarget.dataset.id);
    if (!pet) return;
    this.setData({
      formVisible: true,
      form: { id: pet.id, name: pet.name, species: pet.species, breed: pet.breed || '', birthday: pet.birthday || '', avatarId: avatarIdFor(pet) },
      avatarChoices: avatarOptions(pet.species),
      birthdayText: pet.birthday ? displayDate(pet.birthday) : '',
      formError: '',
    });
  },

  onFormClose() {
    this.setData({ formVisible: false });
  },

  onNameInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ 'form.name': e.detail.value, formError: '' });
  },

  onBreedInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ 'form.breed': e.detail.value });
  },

  onSelectSpecies(e: WechatMiniprogram.TouchEvent) {
    const species = e.currentTarget.dataset.value;
    this.setData({ 'form.species': species, 'form.avatarId': avatarIdFor({ species, avatarId: this.data.form.avatarId }), avatarChoices: avatarOptions(species), formError: '' });
  },

  onSelectAvatar(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id;
    if (this.data.avatarChoices.some(option => option.id === id)) this.setData({ 'form.avatarId': id });
  },

  onOpenBirthday() {
    const value = this.data.form.birthday
      ? new Date(`${this.data.form.birthday}T00:00:00`).getTime()
      : Date.now();
    this.setData({ dateVisible: true, dateValue: value });
  },

  onBirthdayConfirm(e: WechatMiniprogram.CustomEvent) {
    const d = fmt(new Date(e.detail.value));
    this.setData({ 'form.birthday': d, birthdayText: displayDate(d), dateVisible: false });
  },

  onBirthdayCancel() {
    this.setData({ dateVisible: false });
  },

  async onSavePet() {
    if (this._savingPet) return;
    const { id, name, species, breed, birthday, avatarId } = this.data.form;
    if (!name.trim()) {
      this.setData({ formError: '给它起个名字吧' });
      return;
    }
    if (!species) {
      this.setData({ formError: '选择一下物种' });
      return;
    }
    this._savingPet = true;
    try {
      if (!this._petCreateId) this._petCreateId = uid();
      await savePet({ id: id || undefined, name, species, breed, birthday, avatarId, clientId: this._petCreateId });
      this.setData({ formVisible: false });
      this.reload();
      Toast({ context: this, selector: '#t-toast', message: id ? '已保存' : '欢迎新伙伴', theme: 'success' });
    } catch (err: any) {
      this.setData({ formError: err.message || '保存失败，请重试' });
    } finally { this._savingPet = false; }
  },

  onDeletePet(e: WechatMiniprogram.TouchEvent) {
    const pet = this.data.pets.find((p) => p.id === e.currentTarget.dataset.id);
    if (!pet) return;
    Dialog.confirm({
      context: this,
      selector: '#t-dialog',
      title: `删除「${pet.name}」？`,
      content: '它的所有日记也会从当前空间隐藏。云端操作仅家庭创建者可执行。',
      confirmBtn: { content: '删除', theme: 'danger' },
      cancelBtn: '再想想',
    }).then(async () => {
      await removePet(pet.id);
      this.setData({ formVisible: false });
      this.reload();
    }).catch((err: any) => { if (err?.message) Toast({ context: this, selector: '#t-toast', message: err.message, theme: 'error' }); });
  },

  /* ---------- 设置 ---------- */

  goModel() {
    wx.navigateTo({ url: '/pages/model/model' });
  },

  goFamily() { wx.navigateTo({ url: '/pages/family/family' }); },

  goSelftest() {
    wx.navigateTo({ url: '/pages/selftest/selftest' });
  },

  onAbout() {
    // 连点 5 次「关于」进入开发者模式（显示开发自检入口）
    const taps = this.data.aboutTaps + 1;
    this.setData({ aboutTaps: taps });
    if (taps >= 5 && !this.data.devMode) {
      this.setData({ devMode: true });
      Toast({ context: this, selector: '#t-toast', message: '已进入开发者模式', theme: 'success' });
    }
    Dialog.alert({
      context: this,
      selector: '#t-dialog',
      title: '记一下喵',
      content: '用聊天的方式，记下和小家伙的每一天。\n已确认的日记保存在你的家庭空间，换设备登录后仍可查看。',
      confirmBtn: '知道啦',
    });
  },

  onClear() {
    Dialog.confirm({
      context: this,
      selector: '#t-dialog',
      title: getCloudSession() ? '清除本机缓存？' : '清除本机数据？',
      content: getCloudSession() ? '清除当前家庭在本机的缓存和聊天记录。云端宠物和日记保留，下次进入会重新读取。' : '本机宠物、日记和聊天记录都会被删除（模型配置保留）',
      confirmBtn: { content: '全部清除', theme: 'danger' },
      cancelBtn: '取消',
    }).then(() => {
      clearAll();
      this.reload();
      Toast({ context: this, selector: '#t-toast', message: '已清除', theme: 'success' });
    }).catch(() => { });
  },
});
