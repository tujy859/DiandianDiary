/** 聊天页视口与键盘；共享原 Page 实例，不另建状态副本。 */


export const chatViewportMethods = {
  initViewport(this: any) {


    /*
     * 键盘避让分两条路：
     * - 安卓：键盘弹起时视口被压缩、100vh 变小，输入台在页面流底部自然落到键盘上沿，
     *   不依赖任何键盘高度接口，不上报高度的机型也一样工作。
     * - 其他平台（iOS/鸿蒙等）：视口不会被可靠压缩，键盘直接盖住页面底部，
     *   必须监听键盘高度，给输入台加 margin-bottom 手动顶起（_manualLift），
     *   同时关闭 adjust-position，防止系统自动推页面与手动顶起叠加。
     */
    try {
      const info = (wx as any).getDeviceInfo ? (wx as any).getDeviceInfo() : wx.getSystemInfoSync();
      const platform = (info && info.platform) || '';
      if (platform !== 'android') {
        this._manualLift = true;
        this.setData({ adjustPosition: false });
      }
    } catch (e) { /* 获取失败则保持视口压缩方案 */ }
    if (typeof wx.onKeyboardHeightChange === 'function') {
      const handler = (res: any) => this.setKeyboardHeight((res && res.height) || 0);
      wx.onKeyboardHeightChange(handler);
      this._offKeyboard = () => {
        if (typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(handler);
      };
    }
  },

  syncTabbarVisibility(this: any, hidden: boolean) {
    const tabbar: any = this.getTabBar && this.getTabBar();
    if (tabbar && tabbar.data.hidden !== hidden) tabbar.setData({ hidden });
  },

  setKeyboardHeight(this: any, height: number) {
    this._lastKeyboard = height || 0;
    const keyboardUp = this.data.focusFlag || this._lastKeyboard > 0;
    const keyboardOffset = this._manualLift && keyboardUp ? this._lastKeyboard : 0;
    if (
      keyboardUp !== this.data.keyboardUp ||
      this._lastKeyboard !== this.data.keyboardHeight ||
      keyboardOffset !== this.data.keyboardOffset
    ) {
      this.setData({ keyboardHeight: this._lastKeyboard, keyboardUp, keyboardOffset });
    }
    this.syncTabbarVisibility(keyboardUp);
    if (keyboardUp) setTimeout(() => this.scrollToBottom(), 80);
  },

  collapseKeyboard(this: any) {
    this._lastKeyboard = 0;
    this.setData({ keyboardHeight: 0, keyboardUp: false, keyboardOffset: 0 });
    this.syncTabbarVisibility(false);
  },

  onKeyboardHeight(this: any, e: WechatMiniprogram.CustomEvent) {
    this.setKeyboardHeight((e.detail && e.detail.height) || 0);
  },

  onFocus(this: any, e: WechatMiniprogram.CustomEvent) {
    this.refreshTopicBoundary();
    const h = (e.detail && e.detail.height) || this._lastKeyboard;
    this.setData({ focusFlag: true });
    this.setKeyboardHeight(h);
  },

  onBlur(this: any) {
    this.setData({ focusFlag: false });
    // 延迟一拍：安卓上 blur 与视口恢复不是同一帧，立即清零会闪一下
    setTimeout(() => { if (!this.data.focusFlag) this.collapseKeyboard(); }, 120);
  },

  onTapPageBlank(this: any) {
    if (this.data.focusFlag || this.data.keyboardUp) {
      wx.hideKeyboard();
      this.setData({ focusFlag: false });
      this.collapseKeyboard();
    }
  }
};
