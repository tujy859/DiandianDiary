Component({
    data: {
        selected: 1,
        list: [
            { pagePath: '/pages/album/album', text: '时光册', icon: 'image' },
            { pagePath: '/pages/chat/chat', text: '聊聊', icon: 'cat', center: true },
            { pagePath: '/pages/mine/mine', text: '我的', icon: 'user-circle' },
        ],
    },
    lifetimes: {
        attached() {
            // 测量 tabBar 真实高度，供各页面精确预留底部空间，避免机型差异导致的空隙
            setTimeout(() => {
                wx.createSelectorQuery()
                    .in(this)
                    .select('.tabbar')
                    .boundingClientRect((rect) => {
                        if (rect && rect.height) {
                            const app = getApp();
                            if (app && app.globalData) {
                                app.globalData.tabbarHeight = Math.ceil(rect.height);
                            }
                        }
                    })
                    .exec();
            }, 120);
        },
    },
    methods: {
        onSwitch(e) {
            const { path, index } = e.currentTarget.dataset;
            if (index === this.data.selected) return;
            wx.switchTab({ url: path });
        },
    },
});
