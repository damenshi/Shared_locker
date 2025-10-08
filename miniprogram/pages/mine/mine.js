// pages/mine/mine.js
const app = getApp();

Page({
  data: {
    userInfo: {},    // 存储用户头像昵称信息
    phone: '',       // 初始化手机号为空
    password: '',
    openid: '',
    isAdmin: '',
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
      // deviceId: app.globalData.deviceId || '',
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

      if (!res.result?.success) 
        throw new Error('获取用户信息失败');
      
      const userData = res.result.data;
      console.log("userData:", userData);
      this.setData({
        phone: userData.phone || '',
        deposit: userData.deposit || 0,
        isAdmin: userData.isAdmin || false,
      });

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
      return wx.showToast({ title: '余额不足', icon: 'none' });
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
            //需要先确定用户订单是否已完成或者已取消，才能退款
            const orderRes = await wx.cloud.callFunction({
              name: 'order',
              data: {
                action: 'getUserOrders',
                openid,
              }
            });

            const orders = orderRes.result?.data || [];
            // 遍历检查
            for (const order of orders) {
              if (order.status === '进行中') {
                throw new Error(`订单 ${order._id} 未完成，无法退款`);
              }
            }

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
              throw new Error(`退款失败`)
            }
          } catch (err) {
            console.error('退款失败：', err);
            wx.showToast({ title: err.message || '系统错误，请重试', icon: 'none' });
          } finally {
            wx.hideLoading();
          }
        }
      }
    });
  },


  // 页面跳转方法
  goMyOrders() { wx.navigateTo({ url: '/pages/mine/myorder' }); },

  goAdmin(){
    wx.navigateTo({
      url: '/pages/admin/admin'
    })
  }
});