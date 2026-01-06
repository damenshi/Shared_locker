const app = getApp();

Page({
  data: {
    latestItem: null, // 修改点：单独存储最新一条
    historyList: [],  // 修改点：存储历史记录
    showHistory: false // 修改点：控制历史记录折叠状态
  },

  onShow() {
    this.loadWallet();
  },

  onPullDownRefresh() {
    this.loadWallet();
  },

  // 修改点：新增切换折叠状态的函数
  toggleHistory() {
    this.setData({
      showHistory: !this.data.showHistory
    });
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
        const delayTimes = 16 * 60 * 60 * 1000;
        // const delayTimes = 10 * 1000;

        // 1. 先处理所有数据格式
        let allList = res.result.data.map(item => {
          const applyTime = new Date(item.refundApplyTime).getTime();
          const canWithdraw = (now - applyTime) >= delayTimes;
          
          const formatNum = (n) => n.toString().padStart(2, '0');
          const formatFullTime = (date) => `${formatNum(date.getMonth() + 1)}-${formatNum(date.getDate())} ${formatNum(date.getHours())}:${formatNum(date.getMinutes())}`;

          const dateObj = new Date(item.refundApplyTime);
          const unlockTimeObj = new Date(applyTime + delayTimes);

          return {
            ...item,
            canWithdraw,
            displayTime: formatFullTime(dateObj),
            availableTime: formatFullTime(unlockTimeObj),
            rawTime: applyTime // 用于排序
          };
        });

        // 2. 按时间倒序排序（确保最新的在最前）
        allList.sort((a, b) => b.rawTime - a.rawTime);

        // 3. 拆分数据
        const latestItem = allList.length > 0 ? allList[0] : null;
        const historyList = allList.length > 1 ? allList.slice(1) : [];
        
        this.setData({ 
          latestItem, 
          historyList 
        });
      }
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // async doWithdraw(e) {
  //   // ... 保持原有逻辑不变 ...
  //   const orderId = e.currentTarget.dataset.id;
  //   wx.showModal({
  //     title: '提现',
  //     content: '确认将该笔款项退回原支付账户？',
  //     success: async (res) => {
  //       if (res.confirm) {
  //         wx.showLoading({ title: '提现中...' });
  //         try {
  //           const callRes = await wx.cloud.callFunction({
  //             name: 'order',
  //             data: { action: 'withdrawRefund', orderId: orderId }
  //           });
  //           wx.hideLoading();
  //           if (callRes.result.success) {
  //             wx.showModal({
  //               title: '提现成功',
  //               content: '提现已成功，请注意查收。',
  //               showCancel: false,
  //               confirmText: '好的',
  //               success: (res) => {
  //                 if (res.confirm) {
  //                   //this.loadWallet(); 
  //                 }
  //               }
  //             });
  //           } else {
  //             wx.showModal({
  //               title: '提现失败',
  //               content: callRes.result.errMsg || '未知原因，请联系客服',
  //               showCancel: false,
  //               confirmText: '关闭'
  //             });
  //           }
  //         } catch (err) {
  //           wx.hideLoading();
  //           wx.showModal({
  //             title: '系统提示',
  //             content: '网络异常或服务繁忙，请稍后重试',
  //             showCancel: false,
  //             confirmText: '关闭'
  //           });
  //         }
  //       }
  //     }
  //   })
  // }

  async doWithdraw(e) {
    const orderId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '提现',
      content: '确认将该笔款项退回原支付账户？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '提现中...' });
          try {
            const callRes = await wx.cloud.callFunction({
              name: 'order',
              data: { action: 'withdrawRefund', orderId: orderId }
            });
            wx.hideLoading();
            
            if (callRes.result.success) {
              // === 修改点开始：手动更新本地数据状态，不刷新列表 ===
              
              // 1. 提示成功
              wx.showToast({ title: '提现成功', icon: 'success' });

              // 2. 查找并更新 latestItem (如果当前操作的是最新那条)
              if (this.data.latestItem && this.data.latestItem._id === orderId) {
                this.setData({
                  'latestItem.status': '已退款',
                  'latestItem.canWithdraw': false // 禁用按钮逻辑
                });
              } else {
                // 3. 查找并更新 historyList (如果是在历史记录里)
                const index = this.data.historyList.findIndex(item => item._id === orderId);
                if (index !== -1) {
                  const key = `historyList[${index}].status`;
                  const keyCanWithdraw = `historyList[${index}].canWithdraw`;
                  this.setData({
                    [key]: '已退款',
                    [keyCanWithdraw]: false
                  });
                }
              }
              // === 修改点结束 ===

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