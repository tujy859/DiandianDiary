import {
  getPets, getCurrentPet, setCurrentPet, getRecords, Pet, DiaryRecord, getCloudSession,
} from '../../utils/store';
import { displayDate, relDay } from '../../utils/date';
import { refreshCloud } from '../../utils/repository';
import { petAvatar } from '../../utils/pet-avatars';
import { showPetPicker } from '../../utils/pet-picker';
import { getLayout } from '../../utils/layout';

interface TimelineItem extends DiaryRecord {
  dateText: string;
  rel: string;
}

interface GalleryItem {
  src: string;
  recordId: string;
  index: number;
  urls: string[];
  dateText: string;
}

Page({
  data: {
    view: 'timeline' as 'timeline' | 'gallery',
    pets: [] as Pet[],
    currentPet: null as Pet | null,
    petAvatar: '',
    records: [] as TimelineItem[],
    gallery: [] as GalleryItem[],
    tabbarHeight: 60,
    viewportHeight: 667,
  },

  async onShow() {
    if (getCloudSession()) {
      this.setData({ pets: [], currentPet: null, records: [], gallery: [] });
      try { await refreshCloud(); } catch (err: any) {
        wx.showToast({ title: err.message || '云端读取失败', icon: 'none' });
        return;
      }
    }
    const pets = getPets();
    const currentPet = getCurrentPet();
    this.setData({
      pets,
      currentPet,
      petAvatar: currentPet ? petAvatar(currentPet) : '',
      ...getLayout(),
    });
    this.reload();
    const tabbar = this.getTabBar && this.getTabBar();
    if (tabbar) tabbar.setData({ selected: 0 });
  },

  reload() {
    const pet = this.data.currentPet;
    if (!pet) {
      this.setData({ records: [], gallery: [] });
      return;
    }
    const list = getRecords(pet.id);
    const records: TimelineItem[] = list.map((r) => ({
      ...r,
      dateText: displayDate(r.date),
      rel: relDay(r.date),
    }));
    const gallery: GalleryItem[] = [];
    list.forEach((r) => {
      r.photos.forEach((src, index) => {
        gallery.push({ src, recordId: r.id, index, urls: r.photos, dateText: displayDate(r.date) });
      });
    });
    this.setData({ records, gallery });
  },

  onSwitchView(e: WechatMiniprogram.TouchEvent) {
    this.setData({ view: e.currentTarget.dataset.view });
  },

  onOpenDiary(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/diary/diary?id=${e.currentTarget.dataset.id}` });
  },

  onPreviewPhoto(e: WechatMiniprogram.TouchEvent) {
    const { urls, current } = e.currentTarget.dataset;
    wx.previewImage({ urls, current });
  },

  onSwitchPet() {
    showPetPicker(this, this.data.pets);
  },

  onPetSelected(e: WechatMiniprogram.CustomEvent) {
    const { index } = e.detail;
    if (index === this.data.pets.length) {
      wx.switchTab({ url: '/pages/mine/mine' });
      return;
    }
    const pet = this.data.pets[index];
    if (!pet) return;
    setCurrentPet(pet.id);
    this.setData({ currentPet: pet, petAvatar: petAvatar(pet) });
    this.reload();
  },

  goChat() {
    wx.switchTab({ url: '/pages/chat/chat' });
  },
});
