const app = getApp();

Page({
  data: {
    list: []
  },

  onShow() {
    this.loadWallet();
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadWallet();
  },

  async loadWallet() {
    wx.showLoading({ title: '加载中' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getMyWallet', openid: app.globalData.openid || '' }
      });
      
      wx.stopPullDownRefresh();

      if (res.result.success) {
        const now = Date.now();
        // const delayTimes = 1 * 1000;
        const delayTimes = 12 * 60 * 60 * 1000; // 这里的延迟时间按你实际需求设定

        const list = res.result.data.map(item => {
          const applyTime = new Date(item.refundApplyTime).getTime();
          const canWithdraw = (now - applyTime) >= delayTimes;
          
          // 格式化函数：补零
          const formatNum = (n) => n.toString().padStart(2, '0');
          const formatFullTime = (date) => `${formatNum(date.getMonth() + 1)}-${formatNum(date.getDate())} ${formatNum(date.getHours())}:${formatNum(date.getMinutes())}`;

          const dateObj = new Date(item.refundApplyTime);
          const unlockTimeObj = new Date(applyTime + delayTimes);

          return {
            ...item,
            canWithdraw,
            // 申请时间：显示 月-日 时:分
            displayTime: formatFullTime(dateObj),
            // 预计到账：显示 月-日 时:分 
            availableTime: formatFullTime(unlockTimeObj)
          };
        });
        
        this.setData({ list });
      }
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async doWithdraw(e) {
    const orderId = e.currentTarget.dataset.id;
    
    // 二次确认
    wx.showModal({
      title: '提现',
      content: '确认将该笔款项退回原支付账户？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '提现中...' });
          try {
            const callRes = await wx.cloud.callFunction({
              name: 'order',
              data: {
                action: 'withdrawRefund',
                orderId: orderId
              }
            });
            
            wx.hideLoading();
            if (callRes.result.success) {
              wx.showModal({
                title: '提现成功',
                content: '提现已成功，请注意查收。',
                showCancel: false, // 不显示取消按钮
                confirmText: '好的',
                success: (res) => {
                  if (res.confirm) {
                    // 用户点击“好的”之后再刷新列表
                    this.loadWallet(); 
                  }
                }
              });
            } else {
              wx.showModal({
                title: '提现失败',
                content: callRes.result.errMsg || '未知原因，请联系客服',
                showCancel: false,
                confirmText: '关闭'
              });
            }
          } catch (err) {
            wx.hideLoading();
            wx.showModal({
              title: '系统提示',
              content: '网络异常或服务繁忙，请稍后重试',
              showCancel: false,
              confirmText: '关闭'
            });
          }
        }
      }
    })
  }
});