import { petAvatar } from '../../utils/pet-avatars';
import {
  getPets, getCurrentPet, setCurrentPet, getRecords, Pet, DiaryRecord, getCloudSession, getCloudCacheRevision, getCloudSessionEpoch,
} from '../../utils/store';
import { displayDate, relDay } from '../../utils/date';
import { refreshCloudIfStale, displayRecordPhotos } from '../../utils/repository';
import { getLayout, resetViewport } from '../../utils/layout';
import { showPetPicker } from '../../utils/pet-picker';
import { guardReady } from '../../utils/onboard';
import { openAddPet } from '../../utils/pet-navigation';

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
    loading: true,
    refreshing: false,
    loadError: '',
    photoError: '',
    visibleCount: 30,
    hasMore: false,
  },

  /** 缓存优先渲染；后台刷新后只有数据真的变化才重渲染 */
  renderFromStore(tabbarHeight: number) {
    const pets = getPets();
    const currentPet = getCurrentPet();
    this.setData({
      pets,
      currentPet,
      petAvatar: currentPet ? petAvatar(currentPet) : '',
      ...getLayout(),
      tabbarHeight,
    });
    this.reload();
  },

  async onShow() {
    // 收起键盘并重新测量布局
    resetViewport(this);
    if (!guardReady()) return;
    this.renderFromStore(getLayout(true).tabbarHeight);
    const tabbar = this.getTabBar && this.getTabBar();
    if (tabbar) tabbar.setData({ selected: 0 });
    await this.loadCloud();
  },

  async loadCloud(force = false) {
    if (this.data.refreshing) return;
    if (!getCloudSession()) {
      this.setData({ loading: false, loadError: '请先连接云端，再读取时光册' });
      return;
    }
    const revision = getCloudCacheRevision();
    this.setData({ loading: !this.data.records.length, refreshing: true, loadError: '' });
    try {
      const refreshed = await refreshCloudIfStale(force || !this.data.records.length ? 0 : 30000);
      if (refreshed && getCloudCacheRevision() !== revision) this.renderFromStore(this.data.tabbarHeight);
    } catch (err: any) {
      this.renderFromStore(this.data.tabbarHeight);
      if (!getCloudSession()?.familyId) guardReady();
      this.setData({ loadError: err.message || '暂时没能读取时光册，请检查网络后重试' });
    } finally {
      this.setData({ loading: false, refreshing: false });
    }
  },

  onRetry() {
    return this.loadCloud(true);
  },

  goAddPet() {
    openAddPet();
  },

  reload() {
    const pet = this.data.currentPet;
    if (!pet) {
      this.setData({ records: [], gallery: [], hasMore: false, photoError: '' });
      return;
    }
    const all = getRecords(pet.id).filter(r => this.data.view !== 'gallery' || r.photos.length);
    const list = all.slice(0, this.data.visibleCount);
    this.setData({ hasMore: all.length > list.length });
    this.renderRecords(list);
    this.loadPhotos();
  },

  renderRecords(list: DiaryRecord[]) {
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

  async loadPhotos() {
    const records = this.data.records, epoch = getCloudSessionEpoch();
    this.setData({ photoError: '' });
    try {
      const display = await displayRecordPhotos(records);
      if (epoch === getCloudSessionEpoch() && this.data.records === records) this.renderRecords(display);
    } catch (_) {
      if (epoch === getCloudSessionEpoch() && this.data.records === records) this.setData({ photoError: '照片暂时无法显示，文字已保留' });
    }
  },

  onLoadMore() {
    this.setData({ visibleCount: this.data.visibleCount + 30 });
    this.reload();
  },

  onSwitchView(e: WechatMiniprogram.TouchEvent) {
    this.setData({ view: e.currentTarget.dataset.view });
    this.setData({ visibleCount: 30 });
    this.reload();
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
      openAddPet();
      return;
    }
    const pet = this.data.pets[index];
    if (!pet) return;
    setCurrentPet(pet.id);
    this.setData({ currentPet: pet, petAvatar: petAvatar(pet), visibleCount: 30 });
    this.reload();
  },

  goChat() {
    wx.switchTab({ url: '/pages/chat/chat' });
  },
});
