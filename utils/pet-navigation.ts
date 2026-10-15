/** 跨 tab 的一次性添加意图，避免切到「我的」后还要再找一次按钮。 */
let addPetRequested = false;

export function openAddPet(): void {
  addPetRequested = true;
  wx.switchTab({
    url: '/pages/mine/mine',
    fail: () => {
      addPetRequested = false;
      wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
    },
  });
}

export function consumeAddPetRequest(): boolean {
  const requested = addPetRequested;
  addPetRequested = false;
  return requested;
}
