Page({
  data: {
    phone: '',       // 手机号
    password: '',        // 取件码
    isLoading: false,
    deviceId: 'L0001',
    constants: {
      ORDER_STATUS_PROCESSING: '进行中',
      NAVIGATE_DELAY: 2000,
      // ORDER_DETAIL_PAGE: '/pages/order/detail'
    }
  },

  onLoad(options) {
    // 接收并验证首页传递的参数
    this.setData({
      phone: options.phone || '',
      password: options.password || '',
      // deviceId: options.deviceId || null,
      deviceId: 'L0001'
    });
    this.handleStoreItem();
  },

  /**
   * 参数验证
   * @returns {boolean} 验证是否通过
   */
  validateParams() {
    if (!this.data.phone || !this.data.password) {
      wx.showToast({ title: '请先输入手机号和取件码', icon: 'none' });
      return false;
    }
    if (!/^\d{11}$/.test(this.data.phone)) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' });
      return false;
    }
    if (this.data.password.length !== 4) {
      wx.showToast({ title: '请输入4位取件码', icon: 'none' });
      return false;
    }
    return true;
  },

  /**
   * 查询可用柜子
   * @returns {Object|null} 可用柜子信息或null
   */
  async getAvailableCabinet() {
    try {
      const deviceId = this.data.deviceId;
      console.log("deviceId: ", deviceId);
      if (!deviceId || !/^L\d+$/.test(deviceId)) {
        wx.showToast({ title: '设备ID格式错误', icon: 'none' });
        return null;
      }
      const res = await wx.cloud.callFunction({
        name: "locker",
        data: { 
          action: "listFree",
          deviceId: deviceId
        } 
      });
      
      console.log("查询可用柜子结果：", res.result);
      
      if (res.result?.success && res.result.data?.length > 0) {
        return res.result.data[0];
      } else {
        wx.showToast({ title: '储物柜已满', icon: 'none' });
        return null;
      }
    } catch (e) {
      console.error("查询可用柜失败", e);
      wx.showToast({ title: '查询柜子异常', icon: 'none' });
      return null;
    }
  },

  /**
   * 创建订单
   * @param {Object} lockerInfo - 柜子信息
   * @returns {string|null} 订单ID或null
   */
  async createOrder(lockerInfo) {
    try {
      // 调用参数验证
      if (!this.validateParams()) {
        return null;
      }

      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "createOrder",
          lockerId: lockerInfo._id,
          phone: this.data.phone,
          password: this.data.password
        }
      });

      if (res.result?.orderId) {
        this.setData({ currentOrderId: res.result.orderId });
        return res.result.orderId;
      }else {
        wx.showToast({ title: '创建订单失败', icon: 'none' });
        return null;
      }
    } catch (e) {
      console.error("创建订单异常", e);
      wx.showToast({ title: '创建订单异常', icon: 'none' });
      return null;
    }
  },

  // 获取订单详情
  async getOrderDetail(orderId) {
    const res = await wx.cloud.callFunction({
      name: "order",
      data: {
        action: "getOrder",
        id: orderId
      }
    });
    return res.result.data;
  },

  /**
   * 模拟支付成功
   * @param {string} orderId - 订单ID
   * @returns {boolean} 支付是否成功
   */
  async mockPaymentSuccess(orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "mockPaySuccess",
          orderId: orderId
        }
      });
      return !!res.result?.success;
    } catch (e) {
      console.error("模拟支付失败", e);
      return false;
    }
  },

  /**
   * 验证订单状态是否为进行中
   * @param {string} orderId - 订单ID
   * @returns {boolean} 状态是否有效
   */
// async verifyOrderStatus(orderId) {
//     try {
//       const res = await wx.cloud.callFunction({
//         name: "order",
//         data: {
//           action: "getOrder",
//           id: orderId
//         }
//       });
      
//       if (!res.result?.data) {
//         wx.showToast({ title: '查询订单失败', icon: 'none' });
//         return false;
//       }

//       if (res.result.data.status !== this.data.constants.ORDER_STATUS_PROCESSING) {
//         wx.showToast({ 
//           title: `订单状态异常（当前：${res.result.data.status}）`, 
//           icon: 'none' 
//         });
//         return false;
//       }
//       return true;
//     } catch (e) {
//       console.error("验证订单状态异常", e);
//       wx.showToast({ title: '验证订单状态失败', icon: 'none' });
//       return false;
//     }
//   },

  /**
   * 打开柜门
   * @param {Object} lockerInfo - 柜子信息
   * @param {string} orderId - 订单ID
   * @returns {boolean} 开柜是否成功
   */
  async openCabinet(lockerInfo, orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "openDoor",
          deviceId: lockerInfo.deviceId,
          doorNo: lockerInfo.doorNo,
          orderId: orderId,
          cabinetNo: lockerInfo.cabinetNo,
          type: "store"
        }
      });
      
      console.log("开柜接口返回：", res.result);
      return res.result?.ok === true;
    } catch (e) {
      console.error("开门失败", e);
      return false;
    }
  },

  /**
   * 恢复柜子状态为空闲
   * @param {number} doorNo - 柜门
   */
  async recoverLocker(deviceId, doorNo, cabinetNo) {
    if (!doorNo) return;
    
    try {
      const res = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "recoverLocker",
          deviceId: deviceId,
          doorNo: doorNo,
          cabinetNo: cabinetNo
        }
      });
      console.log(`柜门 ${deviceId}_${cabinetNo}_${doorNo} 恢复结果：`, res.result);
    } catch (e) {
      console.error(`柜门 ${deviceId}_${cabinetNo}_${doorNo} 恢复失败`, e);
    }
  },

  async recoverOrder(orderId, targetStatus = '已取消') {
    if (!orderId) {
      console.warn('恢复订单失败：订单ID不能为空');
      return;
    }
    
    try {
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "recoverOrder",
          orderId: orderId,
          targetStatus: targetStatus // 可选：指定恢复后的状态
        }
      });
      console.log(`订单 ${orderId} 恢复结果：`, res.result);
      if (res.result.success) {
        wx.showToast({ title: `订单已恢复为${targetStatus}`, icon: 'none' });
      } else {
        wx.showToast({ title: res.result.errMsg, icon: 'none' });
      }
    } catch (e) {
      console.error(`订单 ${orderId} 恢复失败`, e);
      wx.showToast({ title: '订单恢复异常', icon: 'none' });
    }
  },

  // 支付确认弹窗
  showPaymentConfirmModal() {
    return new Promise(resolve => {
      // 只显示押金相关的支付信息
      wx.showModal({
        title: '确认支付',
        content: `需支付押金 15元，取件后可退还`,
        success: (res) => {
          resolve(res.confirm);
        },
        fail: () => {
          resolve(false);
        }
      });
    });
  },

  /**
   * 核心存包流程
   */
  async handleStoreItem() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });
    wx.showLoading({ title: '处理中...' });

    let lockerInfo = null;
    let orderId = null;

    try {
      // 1. 参数验证
      if (!this.validateParams()) {
        setTimeout(() => wx.navigateBack({ delta: 1 }), this.data.constants.NAVIGATE_DELAY);
        return;
      }

      // 2. 获取可用柜子
      lockerInfo = await this.getAvailableCabinet();
      if (!lockerInfo) {
        setTimeout(() => wx.navigateBack({ delta: 1 }), this.data.constants.NAVIGATE_DELAY);
        return;
      }

      // 3. 创建订单
      orderId = await this.createOrder(lockerInfo);
      if (!orderId) return;

      // 4. 查询订单状态，判断是否需要支付
      const order = await this.getOrderDetail(orderId);
      if (order.status === this.data.constants.ORDER_STATUS_PROCESSING) {
        // 有足够押金，直接跳过支付流程
        wx.showToast({ title: '账户已有押金，无需额外支付', icon: 'none' });
      } else {
        // 押金不足，需要支付
        const confirmPay = await this.showPaymentConfirmModal();
        if (!confirmPay) {
          await this.recoverLocker(lockerInfo.deviceId, lockerInfo.doorNo, lockerInfo.cabinetNo);
          await this.recoverOrder(orderId);
          wx.navigateBack({ delta: 1 });
          return;
        }

        // 模拟支付
        wx.showLoading({ title: '支付押金中...' });
        const paySuccess = await this.mockPaymentSuccess(orderId);
        if (!paySuccess) {
          wx.showToast({ title: '支付失败', icon: 'none' });
          await this.recoverLocker(lockerInfo.deviceId, lockerInfo.doorNo, lockerInfo.cabinetNo);
          await this.recoverOrder(orderId);
          return;
        }
      }

      // 7. 开柜操作
      wx.showLoading({ title: '打开柜门中...' });
      const openSuccess = await this.openCabinet(lockerInfo, orderId);
      const opennum = (lockerInfo.cabinetNo - 1) * 2 + lockerInfo.doorNo;//每个锁板包含两个锁

      if (openSuccess) {
        wx.hideLoading();
        wx.showToast({ 
          title: `柜门 ${opennum} 已打开`, 
          icon: 'success',
          duration: 3000
        });
      } else {
        wx.hideLoading();
        wx.showToast({ title: '开门失败', icon: 'none' });
        await this.recoverLocker(lockerInfo.deviceId, lockerInfo.doorNo, lockerInfo.cabinetNo);
        await this.recoverOrder(orderId);
      }
    } catch (e) {
      console.error("存包流程异常", e);
      wx.showToast({ title: '操作失败', icon: 'none' });
      if (lockerInfo) await this.recoverLocker(lockerInfo.deviceId, lockerInfo.doorNo, lockerInfo.cabinetNo);
      if (orderId) await this.recoverOrder(orderId);
    } finally {
      this.setData({ isLoading: false });
      wx.hideLoading();
    }
  }
});
