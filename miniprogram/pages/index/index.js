const db = wx.cloud.database()
const app = getApp(); 
Page({
  data: {
    phone: '',
    password: '',
    canProceed: false
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
    
    // 跳转到支付页面
    wx.navigateTo({
      url: `/pages/store/store?phone=${this.data.phone}&password=${this.data.password}`
    });
  },
});
