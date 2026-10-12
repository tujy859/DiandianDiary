import Dialog from 'tdesign-miniprogram/dialog/index';
import Toast from 'tdesign-miniprogram/toast/index';
import {
  getRecord, updateRecord, removeRecord, getPets, persistPhotos, petEmoji, Pet, DiaryRecord,
} from '../../utils/store';
import { displayDate, relDay } from '../../utils/date';
import { extractTags } from '../../utils/intent';

Page({
  data: {
    id: '',
    record: null as (DiaryRecord & { dateText?: string; rel?: string; petName?: string; petAvatar?: string }) | null,
    pets: [] as Pet[],
    editorVisible: false,
    editorValue: {} as any,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ id: options.id || '', pets: getPets() });
  },

  onShow() {
    this.reload();
  },

  reload() {
    const rec = this.data.id ? getRecord(this.data.id) : null;
    if (!rec) {
      this.setData({ record: null });
      return;
    }
    const pet = this.data.pets.find((p) => p.id === rec.petId);
    this.setData({
      record: {
        ...rec,
        dateText: displayDate(rec.date),
        rel: relDay(rec.date),
        petName: pet ? pet.name : '未知宠物',
        petAvatar: pet ? petEmoji(pet.species) : '🐾',
      },
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
    const { petId, date, text, photos } = e.detail;
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const savedPhotos = await persistPhotos(photos);
      const tags = text !== this.data.record!.text ? extractTags(text) : this.data.record!.tags;
      updateRecord(this.data.id, { petId, date, text, photos: savedPhotos, tags });
      wx.hideLoading();
      this.setData({ editorVisible: false });
      this.reload();
      Toast({ context: this, selector: '#t-toast', message: '已保存', theme: 'success' });
    } catch (err) {
      wx.hideLoading();
      Toast({ context: this, selector: '#t-toast', message: '保存失败，请重试', theme: 'error' });
    }
  },

  onDelete() {
    Dialog.confirm({
      context: this,
      selector: '#t-dialog',
      title: '删除这条日记？',
      content: '删除后，时间轴、画廊和查询里都看不到了',
      confirmBtn: { content: '删除', theme: 'danger' },
      cancelBtn: '再想想',
    }).then(() => {
      removeRecord(this.data.id);
      wx.navigateBack();
    }).catch(() => { });
  },
});
