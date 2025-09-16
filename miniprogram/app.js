App({
  globalData: {
    openid: null, // 存储用户openid
    deviceId: null // 存储当前设备ID
  },
  
  onLaunch(options) {
    // 初始化云开发环境
    wx.cloud.init({
      env: require('./config').envId,
      traceUser: true
    });

    // 1. 获取用户openid并缓存
    this.getOpenid();

    // 2. 处理扫码进入的设备ID
    const temp_deviceid = '6de04f165a9c7e88';
    let deviceId = temp_deviceid;
    if (options.query) {
      // 情况1：扫码进入，解析scene参数（微信扫码会将参数放在scene中，且经过编码）
      if (options.query.scene) {
        deviceId = decodeURIComponent(options.query.scene);
      } 
    }
    console.log("app deviceid:", deviceId);
    // 保存deviceId到全局
    if (deviceId) {
      this.globalData.deviceId = deviceId;
      console.log('全局获取到的deviceId:', deviceId);
    }
    
  },

  // 获取用户openid并缓存到本地和全局
  async getOpenid() {
    try {
      // 先查本地缓存，避免重复获取
      const cachedOpenid = wx.getStorageSync('openid');
      if (cachedOpenid) {
        this.globalData.openid = cachedOpenid;
        return;
      }

      // 本地无缓存，调用云函数获取openid
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: {
          action: 'getOpenid'
        }
      });

      if (res.result.openid) {
        this.globalData.openid = res.result.openid;
        // 存入本地缓存，有效期长期（除非用户清除缓存）
        wx.setStorageSync('openid', res.result.openid);
        console.log('openid获取成功并缓存:', res.result.openid);
      }
    } catch (err) {
      console.error('获取openid失败:', err);
    }
  }
})
