Page({
  data: {},

  goStore() {
    wx.navigateTo({
      url: '/pages/index/index'
    })
  },
  goTake() {
    wx.navigateTo({
      url: '/pages/take/take'
    })
  },

  goHome() {
    // 当前已在首页，无需跳转（避免重复压栈）
  },

  goMine() {
    wx.navigateTo({
      url: '/pages/mine/mine'
    })
  }
})
