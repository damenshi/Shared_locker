// pages/mine/complaintForm.js
const app = getApp();

Page({
  data: {
    type: 'refund',
    content: '',
    orderId: '',
    orderInfo: null,
    canSubmit: false,
    openid: ''
  },

  onLoad(options) {
    this.setData({
      openid: app.globalData.openid || ''
    });

    if (options.orderId) {
      this.setData({ orderId: options.orderId });
      this.fetchOrderInfo(options.orderId);
    }
  },

  async fetchOrderInfo(orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: {
          action: 'getOrder',
          orderId: orderId
        }
      });
      if (res.result.success && res.result.data) {
        this.setData({ orderInfo: res.result.data });
      }
    } catch (err) {
      console.error('获取订单信息失败：', err);
    }
  },

  selectType(e) {
    this.setData({
      type: e.currentTarget.dataset.type
    });
    this.checkCanSubmit();
  },

  onContentInput(e) {
    this.setData({
      content: e.detail.value
    });
    this.checkCanSubmit();
  },

  checkCanSubmit() {
    const canSubmit = this.data.content.trim().length > 0;
    this.setData({ canSubmit });
  },

  async submitComplaint() {
    if (!this.data.canSubmit) {
      wx.showToast({ title: '请填写投诉内容', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'complaint',
        data: {
          action: 'createComplaint',
          type: this.data.type,
          content: this.data.content.trim(),
          orderId: this.data.orderId || undefined
        }
      });

      wx.hideLoading();

      if (res.result.success) {
        wx.showToast({ title: '提交成功', icon: 'success' });
        setTimeout(() => {
          wx.navigateBack();
        }, 1500);
      } else {
        wx.showToast({ title: res.result.errMsg || '提交失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('提交投诉失败：', err);
      wx.showToast({ title: '系统错误，请重试', icon: 'none' });
    }
  }
});
