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
      console.log("获取用户订单结果：", res.result.data);
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

  async refund(event) {
    console.log('退款事件：', event)

    wx.showModal({
      title: '确认退款',
      content: `确认退款？`,
      confirmText: '确认',
      cancelText: '取消',
      success: async (res) => {
        if (res.cancel) {
          return;
        }

        if (res.confirm) {
          wx.showLoading({ title: '处理中...', mask: true });

          try {
            const orderId = event.currentTarget.dataset.id;
            const openid = event.currentTarget.dataset.openid;

            const res = await wx.cloud.callFunction({
              name: 'order',
              data: {
                action: 'refundOrder',
                openid: openid,
                orderId: orderId
              }
            });
            console.log('退款结果：', res)

            if (res.result.success) {
              if (!res.result.data.error) {
                wx.showToast({
                  title: '退款成功',
                  icon: 'success',
                  duration: 2000
                });
              } else {
                const errText = res.result?.data?.error || res.result?.data?.errRaw?.response?.text || '';

                let errMsg = '请稍后重试';
                try {
                  if (errText) {
                    const parsed = JSON.parse(errText);
                    errMsg = parsed.message || errMsg;
                  }
                } catch (e) {}

                wx.showToast({
                  title: errMsg,
                  icon: 'error',
                  duration: 2000
                });
              }

              this.onLoad();
            } else {
              wx.showToast({
                title: res.result.errMsg || '退款失败', 
                icon: 'none' 
              });
            }
          } catch (err) {
            wx.showToast({ title: '系统错误', icon: 'none' });
            console.log('系统错误：', err)
          } finally {
            wx.hideLoading();
          }
        }
      }
    });
  }
});