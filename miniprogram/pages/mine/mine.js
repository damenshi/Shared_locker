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

  // 页面跳转方法
  goHome() { wx.switchTab({ url: '/pages/home/home' }); },

  goMyOrders() { wx.navigateTo({ url: '/pages/mine/myorder' }); },

  goAbout() { wx.navigateTo({ url: '/pages/mine/about' }); },

  goMywallet() { wx.navigateTo({ url: '/pages/mine/mywallet' }); },

  customerService() {
    wx.makePhoneCall({ phoneNumber: '400-832-6132' });
  },

  async goAdmin() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'adminPermission' }
      });
      const result = res.result;
      if (!result.isAdmin) {
        throw new Error('无管理员权限');
      }

      if (result.role === 'super') {
        wx.navigateTo({
          url: '/pages/admin/admin'
        });
      } else {
        wx.navigateTo({
          url: `/pages/admin/deviceAdmin?allowed=${JSON.stringify(result.allowedDevices)}`
        });
      }

    }catch (err) {
      console.error('无管理员权限', err);
      wx.showToast({ title: '非管理员无权限进入', icon: 'none' });
    }
  }
  
});