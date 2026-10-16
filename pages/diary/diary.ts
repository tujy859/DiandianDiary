import { petAvatar } from '../../utils/pet-avatars';
import Dialog from 'tdesign-miniprogram/dialog/index';
import Toast from 'tdesign-miniprogram/toast/index';
import {
  getRecord, getPets, persistPhotos, Pet, DiaryRecord, getCloudSession,
} from '../../utils/store';
import { displayDate, relDay } from '../../utils/date';
import { extractTags } from '../../utils/intent';
import { updateRecord, removeRecord, refreshCloudIfStale } from '../../utils/repository';
import { guardReady } from '../../utils/onboard';
import { diarySaveFeedback } from '../../utils/save-feedback';
import { SaveProgress, saveLoadingTitle } from '../../utils/save-progress';

Page({
  data: {
    id: '',
    record: null as (DiaryRecord & { dateText?: string; rel?: string; petName?: string; petAvatar?: string }) | null,
    loading: true,
    refreshing: false,
    loadError: '',
    pets: [] as Pet[],
    editorVisible: false,
    editorValue: {} as any,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ id: options.id || '', pets: getPets() });
  },

  onShow() {
    if (getCloudSession() && !getCloudSession()!.familyId) {
      this.setData({ record: null, pets: [], loading: false, loadError: '请先创建或加入家庭空间' });
      guardReady();
      return;
    }
    return this.loadRecord();
  },

  async loadRecord(force = false) {
    if (this.data.refreshing) return;
    // 先用本地缓存渲染：文字立即可见，照片按 <image> 各自进度加载
    this.setData({ pets: getPets(), loadError: '' });
    this.reload();
    if (!getCloudSession()) {
      this.setData({ loadError: '请先连接云端，再读取这条日记' });
      return;
    }
    // 缓存里没有这条记录时先维持加载态，等云端确认后再判定「不存在」
    this.setData({ loading: !this.data.record, refreshing: true });
    try {
      // 缓存无记录时必须读云端确认；重试也不能被最近成功刷新的节流跳过。
      await refreshCloudIfStale(force || !this.data.record ? 0 : 30000);
      this.setData({ pets: getPets() });
      this.reload();
    } catch (err: any) {
      // 保留已有内容；读取失败不能当作云端确认记录不存在。
      // 权限 / 身份错误可能已清理缓存，此时不能保留失效的页面快照。
      this.setData({ pets: getPets() });
      this.reload();
      this.setData({ loadError: err.message || '暂时没能读取日记，请检查网络后重试' });
      if (!getCloudSession()?.familyId) guardReady();
    } finally {
      this.setData({ loading: false, refreshing: false });
    }
  },

  onRetry() {
    return this.loadRecord(true);
  },

  goAlbum() {
    wx.switchTab({ url: '/pages/album/album' });
  },

  reload() {
    const rec = this.data.id ? getRecord(this.data.id) : null;
    if (!rec) {
      this.setData({ record: null, loading: false });
      return;
    }
    const pet = this.data.pets.find((p) => p.id === rec.petId);
    this.setData({
      record: {
        ...rec,
        dateText: displayDate(rec.date),
        rel: relDay(rec.date),
        petName: pet ? pet.name : '未知宠物',
        petAvatar: petAvatar(pet || { species: '其他' }),
      },
      loading: false,
    });
  },

  onPreview(e: WechatMiniprogram.TouchEvent) {
    const { current } = e.currentTarget.dataset;
    wx.previewImage({ urls: this.data.record!.photos, current });
  },

  onEdit() {
    const rec = this.data.record!;
    this.setData({
      editorVisible: true,
      editorValue: { petId: rec.petId, date: rec.date, text: rec.text, photos: rec.photos.slice() },
    });
  },

  onEditorClose() {
    this.setData({ editorVisible: false });
  },

  async onEditorConfirm(e: WechatMiniprogram.CustomEvent) {
    if (this._saving) return;
    this._saving = true;
    const { petId, date, text, photos } = e.detail;
    wx.showLoading({ title: '保存中…', mask: true });
    let progress: SaveProgress = { stage: 'local' };
    try {
      const savedPhotos = await persistPhotos(photos);
      const tags = text !== this.data.record!.text ? extractTags(text) : this.data.record!.tags;
      await updateRecord(this.data.id, { petId, date, text, photos: savedPhotos, tags }, next => {
        progress = next;
        wx.showLoading({ title: saveLoadingTitle(next), mask: true });
      });
      wx.hideLoading();
      this.setData({ editorVisible: false });
      this.reload();
      Toast({ context: this, selector: '#t-toast', message: '已保存', theme: 'success' });
    } catch (err: any) {
      wx.hideLoading();
      const feedback = diarySaveFeedback(err, progress.stage);
      Dialog.alert({ context: this, selector: '#t-dialog', title: feedback.title, content: feedback.message, confirmBtn: '知道了' });
    } finally { this._saving = false; }
  },

  onDelete() {
    Dialog.confirm({
      context: this,
      selector: '#t-dialog',
      title: '删除这条日记？',
      content: '删除后，时间轴、画廊和查询里都看不到了',
      confirmBtn: { content: '删除', theme: 'danger' },
      cancelBtn: '再想想',
    }).then(async () => {
      await removeRecord(this.data.id);
      wx.navigateBack();
    }).catch((err: any) => { if (err?.message) Toast({ context: this, selector: '#t-toast', message: err.message, theme: 'error' }); });
  },
});
