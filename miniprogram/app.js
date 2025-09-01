App({
  onLaunch() {
    wx.cloud.init({
      env: require('./config').envId,
      traceUser: true
    })
  },
  globalData: {}
})
