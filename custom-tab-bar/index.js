const layout = require('../utils/layout');

/** 键盘高度归零后，再留一点缓冲，等视口完全恢复再切页 */
const KEYBOARD_SETTLE_MS = 80;
/** 拿不到键盘事件的兜底等待时间 */
const SWITCH_FALLBACK_MS = 360;

Component({
    data: {
        selected: 1,
        /** 键盘弹起时由页面置为 true，把底部让给输入台 */
        hidden: false,
        tabbarHeight: 0,
        /** 初始值与样式兜底一致；挂载后替换为公共测量结果。 */
        tabHeightStyle: 'calc(112rpx + 16px)',
        /** 系统安全区与额外留白共用公共度量，不依赖 env()。 */
        bottomPadding: 16,
        list: [
            { pagePath: '/pages/album/album', text: '时光册', icon: 'image' },
            { pagePath: '/pages/chat/chat', text: '聊聊', icon: 'chat' },
            { pagePath: '/pages/mine/mine', text: '我的', icon: 'user-circle' },
        ],
    },

    lifetimes: {
        attached() {
            /** 全局键盘高度：只有键盘真的开着时才需要等待收起 */
            this.keyboardHeight = 0;
            this.offKeyboard = null;
            // 页面与 tabBar 共用同一份测量结果，避免底部留白忽多忽少
            this.applyLayout();
            this.watchKeyboard();
        },
        detached() {
            this.unwatchKeyboard();
        },
    },

    pageLifetimes: {
        show() {
            // 页面重新可见时刷新缓存，抹平键盘残留与安全区变化
            this.keyboardHeight = 0;
            // 上一个页面可能是被键盘藏起来的（聊聊页），切回来一定要恢复
            if (this.data.hidden) this.setData({ hidden: false });
            this.applyLayout();
        },
    },

    methods: {
        applyLayout() {
            const metrics = layout.getLayout(true);
            const style = metrics.tabbarHeight ? metrics.tabbarHeight + 'px' : 'calc(112rpx + 16px)';
            if (style !== this.data.tabHeightStyle
                || metrics.tabbarBottomPadding !== this.data.bottomPadding
                || metrics.tabbarHeight !== this.data.tabbarHeight) {
                this.setData({
                    tabbarHeight: metrics.tabbarHeight,
                    tabHeightStyle: style,
                    bottomPadding: metrics.tabbarBottomPadding,
                });
            }
        },

        watchKeyboard() {
            if (typeof wx.onKeyboardHeightChange !== 'function') return;
            const handler = (res) => { this.keyboardHeight = res.height || 0; };
            wx.onKeyboardHeightChange(handler);
            this.offKeyboard = () => {
                if (typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(handler);
            };
        },

        unwatchKeyboard() {
            if (this.offKeyboard) {
                this.offKeyboard();
                this.offKeyboard = null;
            }
        },

        onSwitch(e) {
            const { path, index } = e.currentTarget.dataset;
            if (Number(index) === this.data.selected || this.switching) return;
            this.switching = true;
            this.pendingPath = path;
            this.switchAfterKeyboard();
        },

        /**
         * 带着软键盘切页时，新页面会以「被键盘压缩」的视口创建，
         * 表现为 tabBar 不贴底、下方多出一块空白。
         * 所以先收起键盘，等高度归零（或兜底超时）再 switchTab。
         */
        switchAfterKeyboard() {
            if (!this.keyboardHeight) {
                this.commitSwitch();
                return;
            }
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                this.settleTimer && clearTimeout(this.settleTimer);
                this.commitSwitch();
            };
            const handler = (res) => {
                if (res && !res.height) {
                    setTimeout(finish, KEYBOARD_SETTLE_MS);
                }
            };
            if (typeof wx.onKeyboardHeightChange === 'function') {
                wx.onKeyboardHeightChange(handler);
                this.keyboardCleanup = () => {
                    if (typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(handler);
                };
            }
            wx.hideKeyboard({ fail: () => { } });
            this.settleTimer = setTimeout(finish, SWITCH_FALLBACK_MS);
        },

        commitSwitch() {
            this.keyboardHeight = 0;
            this.switching = false;
            if (this.keyboardCleanup) {
                this.keyboardCleanup();
                this.keyboardCleanup = null;
            }
            if (this.settleTimer) {
                clearTimeout(this.settleTimer);
                this.settleTimer = null;
            }
            const path = this.pendingPath;
            this.pendingPath = '';
            if (path) wx.switchTab({ url: path });
        },
    },
});
