const db = wx.cloud.database()
const app = getApp(); 
Page({
  data: {
    phone: '',
    password: '',
    openid: '',
    deviceId: null,
    deviceAddress: '',
    freeDoorCnt: '',
    canProceed: false,
    showLockerBox: false, 
    openedLockerNo: '',       // 显示开柜号
    showConfirmModal: false
  },
  
  onLoad(options) {

    if (options && options.query && options.query.deviceId) {
      app.globalData.deviceId = options.query.deviceId;
      console.log('[index] 从扫码参数更新 deviceId:', options.query.deviceId);
    }

    // 每次重新获取设备信息
    app.getDevAddress();
    app.getFreeDoorCnt();

    if (app.globalData.deviceAddress) {
      this.setData({
        deviceAddress: app.globalData.deviceAddress
      });
    } else {
      app.globalData.addressReadyCallback = (address) => {
        this.setData({ deviceAddress: address });
      };
    }

    if (app.globalData.freeDoorCnt) {
      this.setData({
        freeDoorCnt: app.globalData.freeDoorCnt
      });
    } else {
      app.globalData.freedoorReadyCallback = (freeCnt) => {
        this.setData({ freeDoorCnt: freeCnt });
      };
    }

  },

  onUnload() {
    app.globalData.addressReadyCallback = null;
    app.globalData.freedoorReadyCallback = null;
  },

  onShow() {
    this.setData({
      openid: app.globalData.openid || '',
      deviceId: app.globalData.deviceId || '',
    });

    const showLockerBox = wx.getStorageSync('showLockerBox');
    const openedLockerNo = wx.getStorageSync('openedLockerNo');
    if (showLockerBox) {
      this.setData({
        showLockerBox,
        openedLockerNo
      });
    }
  },

  async getPhoneNumber(e) {
    if (e.detail.errMsg !== "getPhoneNumber:ok") {
      wx.showToast({ title: '用户拒绝授权', icon: 'none' })
      return
    }

    try {
      // 第一步：登录获取 code
      const loginRes = await wx.login()
      const code = loginRes.code

      // 第二步：传 encryptedData、iv、code 给云函数
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: {
          action: 'getPhone',
          code,
          encryptedData: e.detail.encryptedData,
          iv: e.detail.iv
        }
      })

      const phone = res.result?.phoneNumber;

      if (phone) {
        this.setData({ phone });
        this.checkCanProceed?.();
      } else {
        wx.showToast({ title: "获取手机号失败", icon: "none" });
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '获取失败', icon: 'none' })
    }
  },

  //显示打开柜号
  showOpenedLocker(lockerNo) {
    this.setData({
      showLockerBox: true,
      openedLockerNo: lockerNo
    });
    wx.setStorageSync('showLockerBox', true);
    wx.setStorageSync('openedLockerNo', lockerNo);
  },

   // 点击中途开柜按钮
   async midopenLocker() {
    if (!this.data.openedLockerNo || !this.data.deviceId) return;

    wx.showLoading('中途开门...');

    try{

      const matchOrder = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "queryByOpenid",
          openid: this.data.openid,
          deviceId: this.data.deviceId
        }
      });
      if (!matchOrder.result?.success) 
        throw new Error('查询用户订单失败');
      const order = matchOrder.result.data;

      // 3. 验证订单状态
      const validStatus = ['进行中', '已支付'];
      if (!validStatus.includes(order.status)) {
        this.setData({ isLoading: false });
        wx.hideLoading();
        this.showError(`订单状态异常：${order.status}`, () => {
          wx.navigateBack({ delta: 1 });
        });
        return;
      }

      const isDoorOpen = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "openDoor",
          deviceId: order.deviceId,
          doorNo: order.doorNo,
          orderId: order._id,
          cabinetNo: order.cabinetNo,
          type: "store"
        }
      });
      if (!isDoorOpen.result?.success){
        this.setData({ isLoading: false });
        wx.hideLoading();
        this.showError('中途开门失败，请重试', () => {
          wx.navigateBack({ delta: 1 });
        });
        throw new Error('中途开门失败');
      }

      wx.hideLoading();

      wx.showToast({ title: '柜门已打开', icon: 'success' });
    }catch (err) {
      wx.hideLoading();
      console.error('中途开门失败：', err);
      wx.showToast({ title: '订单已结束，中途开门失败', icon: 'none' });
    }
  },

  finishUse() {
    wx.navigateTo({
      url: '/pages/take/take'
    })
  },

  // 监听手机号输入
  onPhoneInput(e) {
    const phone = e.detail.value;
    this.setData({
      phone: phone
    });
    this.checkCanProceed();
  },

  // 监听密码输入
  onPasswordInput(e) {
    const pwd = e.detail.value;
    this.setData({
      password: pwd
    });
    this.checkCanProceed();
  },

  // 检查是否可以进入下一步
  checkCanProceed() {
    const { phone, password } = this.data;
    // 手机号11位，密码4位
    const canProceed = phone.length === 11 && password.length === 4;
    this.setData({
      canProceed: canProceed
    });
  },

  // 前往下一步（支付页面）
  goToNextPage() {
    const { phone, password } = this.data;
    if (!phone || !password) {
      wx.showToast({ title: '请填写手机号和取件码', icon: 'none' });
      return;
    }
  
    // 显示自定义确认弹窗
    this.setData({ showConfirmModal: true });
  },
  
  // 点击确认按钮
  handleConfirmNext() {
    const { phone, password } = this.data;
    wx.setStorageSync('phone', phone);
    wx.setStorageSync('password', password);
  
    wx.navigateTo({
      url: `/pages/store/store?phone=${phone}&password=${password}`
    });
  
    this.setData({ showConfirmModal: false });
  },
  
  // 点击取消按钮
  handleCancelConfirm() {
    wx.showToast({ title: '请检查信息后再操作', icon: 'none', duration: 1500 });
    this.setData({ showConfirmModal: false });
  }
  
});
