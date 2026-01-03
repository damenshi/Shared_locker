const app = getApp();

Page({
  data: {
    phone: '',
    password: '',
    openid: '',
    deviceId: null,
    isLoading: false // 加载状态
  },

  onLoad(options) {
    // 接收首页传递的参数并验证
    this.setData({
      openid: app.globalData.openid || '',
      deviceId: app.globalData.deviceId || '',
    });

    const userCache = wx.getStorageSync('userCredentials') || {};
    console.log("userCache:", userCache);
    const userInfo = userCache[app.globalData.openid] || {};
    if (userInfo) {
      this.setData({
        phone: userInfo.phone,
        password: userInfo.password
      });
    }
    // 自动触发取件流程
    if (this.data.phone && this.data.password) {
      this.handleTakeItem();
    } else {
      this.showError('请先存包', () => {
        wx.navigateBack({ delta: 1 });
      });
    }
  },

  /**
   * 显示错误提示并执行回调
   * @param {string} message - 错误信息
   * @param {Function} callback - 回调函数
   * @param {number} duration - 提示时长
   */
  showError(message, callback, duration = 2000) {
    wx.showToast({
      title: message,
      icon: 'none',
      duration
    });
    setTimeout(callback, duration);
  },

  /**
   * 显示成功提示并执行回调
   * @param {string} message - 成功信息
   * @param {Function} callback - 回调函数
   * @param {number} duration - 提示时长
   */
  showSuccess(message, callback) {
    wx.showModal({
      title: '提示',
      content: message,
      showCancel: false,     // 只保留“确定”
      confirmText: '好的',   // iOS 风格按钮
      success: () => {
        if (typeof callback === 'function') {
          callback();
        }
      }
    });
  },
  

  /**
   * 验证输入格式
   * @returns {boolean} 验证结果
   */
  validateInput() {
    const { phone, password } = this.data;

    // 手机号验证（11位数字）
    if (!/^\d{11}$/.test(phone)) {
      wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' });
      return false;
    }

    // 取件码验证（4位数字）
    if (!/^\d{4}$/.test(password)) {
      wx.showToast({ title: '请输入4位取件码', icon: 'none' });
      return false;
    }

    return true;
  },

  /**
   * 核心取件逻辑
   */
  async handleTakeItem() {
    // 防止重复触发
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });
    wx.showLoading({ title: '正在验证取件信息...' });

    try {
      // 1. 验证输入参数
      if (!this.validateInput()) {
        this.setData({ isLoading: false });
        wx.hideLoading();
        throw new Error('您的手机号或取件码无效');
      }

      // 2. 查询匹配订单
      const matchOrder = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "queryByOpenid",
          openid: this.data.openid,
          deviceId: this.data.deviceId
        }
      });
      if (!matchOrder.result?.success) 
        throw new Error('本柜无您进行中的订单，请检查柜号!');
      const order = matchOrder.result.data;

      // 3. 验证订单状态
      const validStatus = ['进行中', '已支付'];
      if (!validStatus.includes(order.status)) {
        this.setData({ isLoading: false });
        wx.hideLoading();
        throw new Error('您的订单已结束或已取消');
      }

      // 4. 打开柜门
      const isDoorOpen = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "openDoor",
          deviceId: this.data.deviceId,
          doorNo: order.doorNo,
          orderId: order._id,
          cabinetNo: order.cabinetNo,
          type: "take"
        }
      });
      if (!isDoorOpen.result?.success){
        this.setData({ isLoading: false });
        wx.hideLoading();
        throw new Error('取件开门失败');
      }

      // 5. 完成订单
      const orderFinishRes = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "finishOrder",
          orderId: order._id
        }
      });
      const isOrderFinished = orderFinishRes.result.success

      // 6. 无论订单是否结束都提示柜门打开
      wx.hideLoading();
      this.setData({ isLoading: false });
      this.showSuccess(
        `取件成功，柜门 ${order.lockerNo} 已打开，订单已结束`,
        () => { wx.navigateBack({ delta: 2 }); }
      );
      wx.setStorageSync('showLockerBox', false);
      wx.setStorageSync('openedLockerNo', '');
      if (!isOrderFinished) {
        throw new Error('取件后订单更新失败');
      }

    } catch (e) {
      console.error("取件流程异常:", e);
      this.setData({ isLoading: false });
      wx.hideLoading();
      const msg = e.message || '取件失败，请重试';

      const finalMsg = `${msg}\n\n如有疑问请拨打客服电话19942291657`;

      wx.showModal({
        title: '提示',
        content: finalMsg,
        showCancel: false,
        confirmText: '好的',
        success: (res) => {
          if (res.confirm) {
            // 用户点击了“好的”
            wx.navigateBack({ delta: 1 });
          }
        }
      });
    }
  }
});