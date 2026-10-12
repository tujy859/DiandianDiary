import ActionSheet from 'tdesign-miniprogram/action-sheet/index';
import {
  getPets, getCurrentPet, setCurrentPet, getRecords, petEmoji, Pet, DiaryRecord,
} from '../../utils/store';
import { displayDate, relDay } from '../../utils/date';

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
  },

  onShow() {
    const pets = getPets();
    const currentPet = getCurrentPet();
    const app: any = getApp();
    this.setData({
      pets,
      currentPet,
      petAvatar: currentPet ? petEmoji(currentPet.species) : '',
      tabbarHeight: (app && app.globalData && app.globalData.tabbarHeight) || 60,
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
    if (!this.data.pets.length) return;
    ActionSheet.show({
      theme: 'list',
      selector: '#t-action-sheet',
      context: this,
      items: this.data.pets.map((p) => ({ label: `${petEmoji(p.species)} ${p.name}` })).concat([{ label: '＋ 添加宠物' }]),
    });
  },

  onPetSelected(e: WechatMiniprogram.CustomEvent) {
    const { index } = e.detail;
    if (index === this.data.pets.length) {
      wx.switchTab({ url: '/pages/mine/mine' });
      return;
    }
    const pet = this.data.pets[index];
    setCurrentPet(pet.id);
    this.setData({ currentPet: pet, petAvatar: petEmoji(pet.species) });
    this.reload();
  },

  goChat() {
    wx.switchTab({ url: '/pages/chat/chat' });
  },
});
