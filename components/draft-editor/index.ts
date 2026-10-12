import { displayDate, fmt } from '../../utils/date';
import { Pet } from '../../utils/store';

Component({
  properties: {
    visible: { type: Boolean, value: false },
    value: { type: Object, value: {} }, // { petId, date, text, photos }
    pets: { type: Array, value: [] },
    title: { type: String, value: '修改这条记录' },
  },
  data: {
    petId: '',
    date: '',
    dateText: '',
    text: '',
    photos: [] as string[],
    dateVisible: false,
    dateValue: 0,
    error: '',
  },
  observers: {
    visible(v: boolean) {
      if (v) this.initFromValue();
    },
  },
  methods: {
    initFromValue() {
      const val = this.data.value || {};
      this.setData({
        petId: val.petId || (this.data.pets[0] && (this.data.pets[0] as Pet).id) || '',
        date: val.date || '',
        dateText: val.date ? displayDate(val.date) : '',
        text: val.text || '',
        photos: (val.photos || []).slice(),
        error: '',
      });
    },
    onSelectPet(e: WechatMiniprogram.TouchEvent) {
      this.setData({ petId: e.currentTarget.dataset.id });
    },
    onOpenDate() {
      const value = this.data.date ? new Date(`${this.data.date}T00:00:00`).getTime() : Date.now();
      this.setData({ dateVisible: true, dateValue: value });
    },
    onDateConfirm(e: WechatMiniprogram.CustomEvent) {
      const d = fmt(new Date(e.detail.value));
      this.setData({ date: d, dateText: displayDate(d), dateVisible: false, error: '' });
    },
    onDateCancel() {
      this.setData({ dateVisible: false });
    },
    onText(e: WechatMiniprogram.CustomEvent) {
      this.setData({ text: e.detail.value, error: '' });
    },
    onAddPhoto() {
      const remain = 9 - this.data.photos.length;
      if (remain <= 0) return;
      wx.chooseMedia({
        count: remain,
        mediaType: ['image'],
        success: (res) => {
          const paths = res.tempFiles.map((f) => f.tempFilePath);
          this.setData({ photos: this.data.photos.concat(paths), error: '' });
        },
      });
    },
    onRemovePhoto(e: WechatMiniprogram.TouchEvent) {
      const { index } = e.currentTarget.dataset;
      const photos = this.data.photos.slice();
      photos.splice(index, 1);
      this.setData({ photos });
    },
    onPreview(e: WechatMiniprogram.TouchEvent) {
      const { index } = e.currentTarget.dataset;
      wx.previewImage({ urls: this.data.photos, current: this.data.photos[index] });
    },
    onCancel() {
      this.triggerEvent('close');
    },
    onConfirm() {
      const { petId, date, text, photos } = this.data;
      if (!petId) {
        this.setData({ error: '请选择宠物' });
        return;
      }
      if (!date) {
        this.setData({ error: '请选择发生日期' });
        return;
      }
      if (!text.trim() && !photos.length) {
        this.setData({ error: '写点文字或加张照片吧' });
        return;
      }
      this.triggerEvent('confirm', { petId, date, text: text.trim(), photos });
    },
    noop() { },
  },
});
