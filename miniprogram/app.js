App({
  globalData: {
    openid: null, // 存储用户openid
    deviceId: null,// 存储当前设备ID
    deviceAddress: null,
    freeDoorCnt: null,
    addressReadyCallback: null,
    freedoorReadyCallback: null,
    miniName: '储物柜' // 小程序名称（从数据库动态获取）
  },
  
  onLaunch(options) {
    // 初始化云开发环境
    wx.cloud.init({
      env: require('./config').envId,
      traceUser: true
    });

    // 1. 设置小程序名称（从数据库动态获取）
    this.setMiniProgramName();

    // 2. 获取用户openid并缓存
    this.getOpenid();
  },

  // 新增：动态获取并设置小程序名称
  async setMiniProgramName() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'getMiniInfo' }
      });
      const miniName = res.result?.miniName || '储物柜';

      // 设置全局导航栏标题
      wx.setNavigationBarTitle({
        title: miniName
      });

      // 保存到全局数据供页面使用
      this.globalData.miniName = miniName;
      console.log('[app.js] 小程序名称:', miniName);
    } catch (e) {
      console.error('[app.js] 获取小程序名称失败:', e);
    }
  },

  onShow(options) {
    // console.log('onShow options:', options);

    let deviceId = null;
    if (options && options.query && options.query.deviceId) {
      deviceId = options.query.deviceId;
      this.globalData.deviceId = deviceId;
      console.log('[onshow]从URL Link获取到 deviceId:', deviceId);
    } else {
      console.log('[onshow]未获取到 deviceId');
    }
    // 其他逻辑
    this.getDevAddress();
    this.getFreeDoorCnt();
  },

  
  // 获取用户openid并缓存到本地和全局
  async getOpenid() {
    try {
      // 先查本地缓存，避免重复获取
      const cachedOpenid = wx.getStorageSync('openid');
      if (cachedOpenid) {
        this.globalData.openid = cachedOpenid;
        console.log('全局获取到的openid:', cachedOpenid);
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
  },

  async getDevAddress() {
    try {
      const getAddRes = await wx.cloud.callFunction({
        name: 'device',
        data: {
          action: 'getDeviceAddress',
          deviceId: this.globalData.deviceId
        }
      });
      if(!getAddRes.result?.success)
        throw new Error('未获取到设备地址');
      const address = getAddRes.result.data;
      this.globalData.deviceAddress = address;

      //如果页面注册了回调，立即通知页面更新显示
      if (this.globalData.addressReadyCallback) {
        this.globalData.addressReadyCallback(address);
      }

    } catch (err) {
      console.error('未获取到设备地址', err);
    }
  },

  async getFreeDoorCnt() {
    try {
      const getFreeRes = await wx.cloud.callFunction({
        name: 'locker',
        data: {
          action: 'getDevFreeDoor',
          deviceId: this.globalData.deviceId
        }
      });
      if(!getFreeRes.result?.success)
        throw new Error('未获取到设备空闲柜门数');
      const freeCnt = getFreeRes.result.data;
      this.globalData.freeDoorCnt = freeCnt;

      //如果页面注册了回调，立即通知页面更新显示
      if (this.globalData.freedoorReadyCallback) {
        this.globalData.freedoorReadyCallback(freeCnt);
      }

    } catch (err) {
      console.error('未获取到设备空闲柜门数', err);
    }
  }
})
