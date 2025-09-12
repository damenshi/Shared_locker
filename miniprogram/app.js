App({
  onLaunch(options) {
    wx.cloud.init({
      env: require('./config').envId,
      traceUser: true
    });

    if (options.query && options.query.deviceId) {
      this.globalData.deviceId = options.query.deviceId;

      // 自动跳转到存包页面，并携带柜子标识
      wx.navigateTo({
        url: `/pages/store/store?deviceId=${options.query.deviceId}`
      });
    }
  },
  globalData: {
    deviceId: null
  }
})
