// pages/mine/mine.js
Page({
  data: {
    userInfo: {},    // 存储用户头像昵称信息
    phone: '',       // 初始化手机号为空
    deposit: 0,      // 初始化余额为0
    recentOrders: [], // 初始化订单列表
    hasCheckedAuth: false // 标记是否已检查过授权状态
  },

  /**
   * 生命周期函数--监听页面显示（每次打开页面都会触发）
   */
  onShow() {
    // 检查本地缓存的用户信息
    // const cachedUserInfo = wx.getStorageSync('userInfo');
    const cachedUserInfo = null;
    if (cachedUserInfo) {
      this.setData({ 
        userInfo: cachedUserInfo,
        hasCheckedAuth: true
      });
    }else {
      // 未获取过用户信息，且是首次检查，触发授权弹窗
      if (!this.data.hasCheckedAuth) {
        this.setData({ hasCheckedAuth: true });
      }
    }
    // 页面显示时获取最新数据
    this.getUserInfo();
    this.getRecentOrders();
  },

  /**
   * 获取用户头像和昵称（授权方法）
   */
  getUserProfile() {

    console.log('触发授权请求'); // 用于调试是否调用
    wx.getUserProfile({
      desc: '用于完善个人资料', // 声明授权用途（必填）
      success: (res) => {
        const userInfo = res.userInfo;
        this.setData({ userInfo });
        // wx.setStorageSync('userInfo', userInfo); // 缓存到本地，避免重复授权
      },
      fail: (err) => {
        console.log('用户拒绝授权', err);
        wx.showToast({
          title: '授权后可显示头像和昵称',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 获取用户信息（包含手机号和余额）
   */
  async getUserInfo() {
    try {
      // 调用云函数获取当前用户信息
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getCurrentUser' }
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
   * 获取最近订单
   */
  async getRecentOrders() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getRecent', limit: 3 }
      });
      if (res.result.success) {
        this.setData({ recentOrders: res.result.data || [] });
      }
    } catch (err) {
      console.error('获取最近订单失败：', err);
    }
  },

  /**
   * 判断订单是否可退款
   */
  canRefund(item) {
    return item.status === '已完成' && !item.isRefunded;
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
  async handleAllRefund() {
    const { deposit, phone } = this.data;
    if (!phone) {
      return wx.showToast({ title: '请先登录', icon: 'none' });
    }
    if (deposit <= 0) {
      return wx.showToast({ title: '余额为0，无需退款', icon: 'none' });
    }

    // 显示确认弹窗
    wx.showModal({
      title: '确认退款',
      content: `确定要将余额 ${deposit.toFixed(2)} 元全部退款吗？`,
      confirmText: '确认退款',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...', mask: true });
          try {
            const res = await wx.cloud.callFunction({
              name: 'order',
              data: {
                action: 'refundAll',
                phone,
                amount: deposit
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

  /**
   * 单个订单退款按钮点击事件
   */
  handleRefund(e) {
    const orderId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '申请退款',
      content: '确定要申请该订单的退款吗？',
      confirmText: '确认申请',
      cancelText: '取消',
      success: async (res) => {
        if (res.confirm) {
          try {
            const res = await wx.cloud.callFunction({
              name: 'order',
              data: { action: 'refund', orderId }
            });
            if (res.result.success) {
              wx.showToast({ title: '退款申请已提交', icon: 'success' });
              this.getRecentOrders();
              this.getUserInfo();
            } else {
              wx.showToast({ title: res.result.errMsg || '申请失败', icon: 'none' });
            }
          } catch (err) {
            console.error('订单退款失败：', err);
            wx.showToast({ title: '系统错误', icon: 'none' });
          }
        }
      }
    });
  },

  // 页面跳转方法
  goMyOrders() { wx.navigateTo({ url: '/pages/orders/orders' }); },
  goRefundRecords() { wx.navigateTo({ url: '/pages/refunds/refunds' }); },
  goOrderDetail(e) { 
    const orderId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/order/detail?id=${orderId}` });
  }
});