import {
  getPets, getCurrentPet, setCurrentPet, getRecords, petEmoji, Pet, DiaryRecord, getCloudSession, getCloudCacheRevision,
} from '../../utils/store';
import { displayDate, relDay } from '../../utils/date';
import { refreshCloudIfStale } from '../../utils/repository';
import { getLayout, resetViewport } from '../../utils/layout';
import { showPetPicker } from '../../utils/pet-picker';
import { guardReady } from '../../utils/onboard';

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

  /** 缓存优先渲染；后台刷新后只有数据真的变化才重渲染 */
  renderFromStore(tabbarHeight: number) {
    const pets = getPets();
    const currentPet = getCurrentPet();
    this.setData({
      pets,
      currentPet,
      petAvatar: currentPet ? petEmoji(currentPet.species) : '',
      tabbarHeight,
    });
    this.reload();
  },

  async onShow() {
    // 收起键盘并重新测量布局
    resetViewport(this);
    if (!guardReady()) return;
    const revision = getCloudCacheRevision();
    this.renderFromStore(getLayout(true).tabbarHeight);
    const tabbar = this.getTabBar && this.getTabBar();
    if (tabbar) tabbar.setData({ selected: 0 });
    if (!getCloudSession()) return;
    try {
      const refreshed = await refreshCloudIfStale();
      if (refreshed && getCloudCacheRevision() !== revision) this.renderFromStore(this.data.tabbarHeight);
    } catch (err: any) {
      wx.showToast({ title: err.message || '云端读取失败', icon: 'none' });
    }
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
    // 与聊聊页共用同一个弹窗实现，避免两页参数/行为漂移
    showPetPicker(this, this.data.pets);
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
