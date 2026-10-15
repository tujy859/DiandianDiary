import { isOffline, watchNetwork } from '../../utils/network';

Component({
  data: { offline: false, dismissed: false },
  lifetimes: {
    attached() {
      this.setData({ offline: isOffline() });
      this._unwatch = watchNetwork((offline: boolean) => this.setData(offline ? { offline } : { offline, dismissed: false }));
    },
    detached() {
      if (this._unwatch) this._unwatch();
    },
  },
  methods: {
    /** 提示条不拦截交互：点一下就收起，避免一直占着屏幕 */
    onDismiss() {
      this.setData({ offline: false, dismissed: true });
    },
  },
});
