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
  },

  onLoad(options) {
    // const globalAddress = app.globalData.deviceAddress || '';
    // this.setData({
    //   deviceAddress: globalAddress
    // });

    // //处理异步延迟：若 app 中地址还没获取完，监听更新
    // if (!app.globalData.deviceAddress) {
    //   this.addressWatcher = setInterval(() => {
    //     const newAddress = app.globalData.deviceAddress;
    //     if (newAddress) {
    //       this.setData({ deviceAddress: newAddress });
    //       clearInterval(this.addressWatcher); // 获取到后停止监听
    //     }
    //   }, 10); // 每 100ms 检查一次
    // }
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
    // if (this.addressWatcher) clearInterval(this.addressWatcher);
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
    // 保存用户输入的手机号和密码
    wx.setStorageSync('phone', this.data.phone);
    wx.setStorageSync('password', this.data.password);
    
    // 跳转到存包页面
    wx.navigateTo({
      url: `/pages/store/store?phone=${this.data.phone}&password=${this.data.password}`
    });
  },

});
