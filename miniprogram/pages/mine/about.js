Page({
  openUserAgreement() {
    wx.navigateTo({ url: '/pages/mine/agreement/userAgreement' });
  },
  openPrivacyPolicy() {
    wx.navigateTo({ url: '/pages/mine/agreement/privacyPolicy' });
  }
});