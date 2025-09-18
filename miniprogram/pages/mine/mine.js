// pages/mine/mine.js
const app = getApp();

Page({
  data: {
    userInfo: {},    // 存储用户头像昵称信息
    phone: '',       // 初始化手机号为空
    password: '',
    openid: '',
    deposit: 0,      // 初始化余额为0
  },

  /**
   * 生命周期函数--监听页面显示（每次打开页面都会触发）
   */

  onLoad(options) {
    // 接收并验证首页传递的参数
    this.setData({
      phone: options.phone || '',
      password: options.password || '',
      openid: app.globalData.openid || '',
      deviceId: app.globalData.deviceId || '',
    });
  },

  onShow() {
    // 检查本地缓存的用户信息
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      this.setData({ userInfo });
    }

    // 页面显示时获取最新数据
    this.getUserInfo();
  },

  /**
   * 获取用户信息（包含手机号和余额）
   */
  async getUserInfo() {
    try {
      // 调用云函数获取当前用户信息
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { 
          action: 'getUserInfo',
          openid: this.data.openid,
        }
      });

      if (res.result.success && res.result.data) {
        const userData = res.result.data;
        this.setData({
          phone: userData.phone || '',
          deposit: userData.deposit || 0
        });
      } else {
        console.log('未获取到用户信息，可能未登录');
      }
    } catch (err) {
      console.error('获取用户信息失败：', err);
    }
  },

  /**
   * 格式化时间
   */
  formatTime(time) {
    if (!time) return '';
    const date = new Date(time);
    return `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours()}:${date.getMinutes()}`;
  },

  /**
   * 全额退款按钮点击事件
   */
  async handleRefund() {
    const { deposit, openid } = this.data;
    if (!openid) {
      return wx.showToast({ title: '请先登录', icon: 'none' });
    }
    if (deposit <= 0) {
      return wx.showToast({ title: '余额为0，无需退款', icon: 'none' });
    }

    // 显示确认弹窗
    wx.showModal({
      title: '确认退款',
      content: `确认全部退款？`,
      confirmText: '确认退款',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...', mask: true });
          try {
            const res = await wx.cloud.callFunction({
              name: 'user',
              data: {
                action: 'refundDeposit',
                openid,
              }
            });

            if (res.result.success) {
              wx.showToast({ title: '退款成功', icon: 'success', duration: 2000 });
              this.getUserInfo(); // 刷新余额
            } else {
              wx.showToast({ title: res.result.errMsg || '退款失败', icon: 'none' });
            }
          } catch (err) {
            console.error('退款失败：', err);
            wx.showToast({ title: '系统错误，请重试', icon: 'none' });
          } finally {
            wx.hideLoading();
          }
        }
      }
    });
  },


  // 页面跳转方法
  // goMyOrders() { wx.navigateTo({ url: '/pages/orders/orders' }); },
  // goRefundRecords() { wx.navigateTo({ url: '/pages/refunds/refunds' }); },
  // goOrderDetail(e) { 
  //   const orderId = e.currentTarget.dataset.id;
  //   wx.navigateTo({ url: `/pages/order/detail?id=${orderId}` });
  // }
});