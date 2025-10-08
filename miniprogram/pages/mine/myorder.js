// pages/mine/orders.js
const app = getApp();

function formatDate(dateStr) {
  const date = new Date(dateStr); // "2025-09-26T16:58:53.136Z"
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

Page({
  data: {
    orders: [],
    loading: true,
    openid: ''
  },

  onLoad() {
    this.setData({
      openid: app.globalData.openid || ''
    });
    this.getOrders();
  },

  /**
   * 获取订单列表
   */
  async getOrders() {
    if (!this.data.openid) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }

    try {
      this.setData({ loading: true });
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: {
          action: 'getUserOrders',
          openid: this.data.openid
        }
      });
      console.log("res.result.data:", res.result.data);
      if (res.result.success) {
        const orders = (res.result.data || []).map(order => {
          if (order.createdAt) {
            order.createdAtFormatted = formatDate(order.createdAt);
          } else {
            order.createdAtFormatted = '无';
          }
          return order;
        });
        this.setData({
          orders,
          loading: false
        });
      } else {
        wx.showToast({ title: res.result.errMsg || '暂无订单', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error('获取订单失败：', err);
      wx.showToast({ title: '系统错误，请重试', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  async refund(e) {
    const orderId = e.currentTarget.dataset.id;
    console.log('点击退款的订单ID:', orderId);

    const res = await wx.cloud.callFunction({
      name: 'order',
      data: {
        action: 'refundOrder',
        orderId: orderId
      }
    });
  }
});