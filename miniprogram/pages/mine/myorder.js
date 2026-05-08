// pages/mine/myorder.js
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

function formatDuration(totalMinutes) {
  // 1. 确保输入是正整数
  if (typeof totalMinutes !== 'number' || totalMinutes < 0) {
    return '0分钟';
  }

  // 2. 计算小时和剩余分钟
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);

  // 3. 格式化输出
  if (hours > 0) {
    // 如果超过1小时，显示 "X小时Y分钟"
    // 如果分钟数为0，也可以选择只显示 "X小时"
    return `${hours}小时${minutes}分钟`;
  } else {
    // 如果不足1小时，只显示 "Y分钟"
    return `${minutes}分钟`;
  }
}

Page({
  data: {
    orders: [],
    loading: true,
    openid: '',
    isExpanded: false
  },

  toggleHistory() {
    this.setData({
      isExpanded: !this.data.isExpanded
    });
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
          if(order.endAt){
            order.endAtFormatted = formatDate(order.endAt);
            order.usageDurationFormatted = formatDuration(order.usageDuration);
          }

          // 状态展示映射字典（对外友好呈现）
          const statusMap = {
            '已强制结束': '异常结束',
            '待支付': '未付款'
            // 已关闭保持原样显示
          };
          order.displayStatus = statusMap[order.status] || order.status;

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

  goComplaint(event) {
    const orderId = event.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/mine/complaintForm?orderId=${orderId}`
    });
  },

  async refund(event) {
    console.log('退款事件：', event)
  
    wx.showModal({
      title: '确认退款',
      content: `确认退款？`,
      confirmText: '确认',
      cancelText: '取消',
      success: async (res) => {
        if (res.cancel) return;
  
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
  
            console.log('退款结果：', res);
            wx.hideLoading();
  
            // 统一弹窗通知结果
            if (res.result.success) {

              // 如果后端返回 delayed，说明是延迟退款，拦截后续流程
              if (res.result.action === 'delayed') {
                wx.showModal({
                  title: '退款申请已提交',
                  content: '退款会在0～3天内完成结算，并转入余额。可前往【我的余额】提现。',
                  showCancel: false,
                  success: () => {
                    if (this.onLoad) this.onLoad(); // 刷新列表
                    else this.handleStoreItem(); // 防止 onLoad 不存在的情况
                  }
                });
                return; // 结束函数，不再执行下面的成功弹窗
              }
            
              const errorMsg = res.result.data?.error;
              const raw = res.result.data?.errRaw?.response?.text;
              let finalMsg = '';
  
              if (!errorMsg) {
                finalMsg = '退款成功！';
                wx.showModal({
                  title: '退款结果:',
                  content: finalMsg,
                  showCancel: false,
                  success: () => {
                    this.onLoad(); // 刷新订单列表
                  }
                });
              } else {
                // 提取失败信息
                let detail = '请稍后重试';
                try {
                  if (raw) detail = JSON.parse(raw).message || detail;
                  else if (errorMsg) detail = errorMsg;
                } catch (e) {}
  
                wx.showModal({
                  title: '退款失败',
                  content: '付款金额为0，请重新选择订单',
                  showCancel: false
                });
              }
  
            } else {
              const errMsg = res.result.errMsg || '退款失败，请稍后重试';
              wx.showModal({
                title: '退款失败',
                content: `${errMsg}\n\n如有疑问，请拨打客服电话400-832-6132`,
                showCancel: false
              });
            }
  
          } catch (err) {
            wx.hideLoading();
            console.error('系统错误：', err)
            wx.showModal({
              title: '系统错误',
              content: '服务器出错，请稍后再试',
              showCancel: false
            });
          }
        }
      }
    });
  }

});