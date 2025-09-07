App({
  onLaunch(options) {
    wx.cloud.init({
      env: require('./config').envId,
      traceUser: true
    });

    if (options.query && options.query.cabinetNo) {
      this.globalData.cabinetNo = options.query.cabinetNo;

      // 自动跳转到存包页面，并携带柜子标识
      wx.navigateTo({
        url: `/pages/store/store?cabinetNo=${options.query.cabinetNo}`
      });
    }
  },
  globalData: {
    cabinetNo: null
  }
})
