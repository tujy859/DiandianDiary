import { displayDate, today, addDays } from '../../utils/date';

Component({
  properties: {
    draft: { type: Object, value: {} },
    petName: { type: String, value: '' },
    saveState: { type: Object, value: {} },
  },
  data: {
    dateText: '',
    chips: [] as Array<{ label: string; value: string }>,
  },
  lifetimes: {
    attached() {
      const t = today();
      this.setData({
        chips: [
          { label: '今天', value: t },
          { label: '昨天', value: addDays(t, -1) },
          { label: '前天', value: addDays(t, -2) },
        ],
      });
      this.refreshDateText();
    },
  },
  observers: {
    'draft.date'() {
      this.refreshDateText();
    },
  },
  methods: {
    refreshDateText() {
      const d = this.data.draft && this.data.draft.date;
      this.setData({ dateText: d ? displayDate(d) : '' });
    },
    onSave() {
      if (this.data.saveState?.busy) return;
      this.triggerEvent('save', { key: this.data.draft.key });
    },
    onEdit() {
      if (this.data.saveState?.busy) return;
      this.triggerEvent('edit', { key: this.data.draft.key });
    },
    onDiscard() {
      if (this.data.saveState?.busy) return;
      this.triggerEvent('discard', { key: this.data.draft.key });
    },
    onView() {
      this.triggerEvent('viewrecord', { recordId: this.data.draft.recordId });
    },
    onChip(e: WechatMiniprogram.TouchEvent) {
      if (this.data.saveState?.busy) return;
      const { value } = e.currentTarget.dataset;
      this.triggerEvent('setdate', { key: this.data.draft.key, date: value });
    },
    onPreview(e: WechatMiniprogram.TouchEvent) {
      const { index } = e.currentTarget.dataset;
      wx.previewImage({ urls: this.data.draft.photos, current: this.data.draft.photos[index] });
    },
  },
});
