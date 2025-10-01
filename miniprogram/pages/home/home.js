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
    wx.navigateTo({
      url: '/pages/home/home'
    })
  },

  goMine() {
    wx.navigateTo({
      url: '/pages/mine/mine'
    })
  }
})
