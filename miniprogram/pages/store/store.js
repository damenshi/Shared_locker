Page({
  // 常量定义：集中管理固定值，便于维护
  constants: {
    NAVIGATE_DELAY: 2000,        // 导航延迟时间(ms)
    ORDER_DETAIL_PAGE: '/pages/orderDetail/orderDetail',
    ORDER_STATUS_PROCESSING: '进行中' // 订单进行中状态
  },

  data: {
    display: {},                 // 格式化的展示数据
    currentOrderId: null,        // 当前订单ID
    isLoading: false,            // 加载状态标记
    phone: '',                   // 从首页传递的手机号
    code: ''                     // 从首页传递的取件码
  },

  onLoad(options) {
    // 接收并验证首页传递的参数
    this.setData({
      phone: options.phone || '',
      code: options.code || ''
    });

    this.handleStoreItem();
  },

  /**
   * 初始化计费规则
   * 加载远程规则，失败时使用默认值
   */
  // async initBillingRules() {
  //   try {
  //     const res = await wx.cloud.callFunction({ 
  //       name: "billing", 
  //       data: { action: "getRules" } 
  //     });
  //     const rules = res.result.data || {};
  //     this.setBillingDisplay(rules);
  //   } catch (e) {
  //     console.error("获取计费规则失败，使用默认规则", e);
  //     // 加载失败时使用默认规则
  //     const defaultRules = {
  //       freeMinutes: 15,
  //       firstPeriodMinutes: 60,
  //       firstPeriodPrice: 300,
  //       unitMinutes: 30,
  //       unitPrice: 100,
  //       capPrice: 2000,
  //       depositPrice: 500
  //     };
  //     this.setBillingDisplay(defaultRules);
  //   }
  // },

  /**
   * 格式化计费规则为展示文本
   * @param {Object} rules - 计费规则数据
   */
  // setBillingDisplay(rules) {
  //   const display = {
  //     free: `免费${rules.freeMinutes || 15}分钟`,
  //     first: `首${rules.firstPeriodMinutes || 60}分钟￥${((rules.firstPeriodPrice || 300) / 100).toFixed(2)}`,
  //     unit: `续费每${rules.unitMinutes || 30}分钟￥${((rules.unitPrice || 100) / 100).toFixed(2)}`,
  //     cap: `封顶￥${((rules.capPrice || 2000) / 100).toFixed(2)}`,
  //     deposit: `押金￥${((rules.depositPrice || 500) / 100).toFixed(2)}`,
  //     totalPrepay: `预支付:￥${(((rules.firstPeriodPrice || 300) + (rules.depositPrice || 500)) / 100).toFixed(2)}`
  //   };
  //   this.setData({ rules, display });
  // },

  /**
   * 参数验证
   * @returns {boolean} 验证是否通过
   */
  validateParams() {
    if (!this.data.phone || !this.data.code) {
      wx.showToast({ title: '请先输入手机号和取件码', icon: 'none' });
      return false;
    }
    if (!/^\d{11}$/.test(this.data.phone)) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' });
      return false;
    }
    if (this.data.code.length !== 6) {
      wx.showToast({ title: '取件码必须是6位', icon: 'none' });
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
      const res = await wx.cloud.callFunction({
        name: "locker",
        data: { action: "listFree" }
      });
      
      console.log("查询可用柜子结果：", res.result);
      
      if (res.result?.success && res.result.data?.length > 0) {
        return res.result.data[0];
      } else {
        wx.showToast({ title: '暂无可用柜子', icon: 'none' });
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
          code: this.data.code
        }
      });

      if (res.result?.orderId) {
        this.setData({ currentOrderId: res.result.orderId });
        return res.result.orderId;
      } else if (res.result?.error) {
        wx.showToast({ 
          title: `创建失败: ${res.result.error}`, 
          icon: 'none', 
          duration: 3000 
        });
        return null;
      } else {
        wx.showToast({ title: '创建订单失败', icon: 'none' });
        return null;
      }
    } catch (e) {
      console.error("创建订单异常", e);
      wx.showToast({ title: '创建订单异常', icon: 'none' });
      return null;
    }
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
  async verifyOrderStatus(orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "getOrder",
          id: orderId
        }
      });
      
      if (!res.result?.data) {
        wx.showToast({ title: '查询订单失败', icon: 'none' });
        return false;
      }

      if (res.result.data.status !== this.constants.ORDER_STATUS_PROCESSING) {
        wx.showToast({ 
          title: `订单状态异常（当前：${res.result.data.status}）`, 
          icon: 'none' 
        });
        return false;
      }
      return true;
    } catch (e) {
      console.error("验证订单状态异常", e);
      wx.showToast({ title: '验证订单状态失败', icon: 'none' });
      return false;
    }
  },

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
          cabinetNo: lockerInfo.cabinetNo,
          orderId: orderId,
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
   * @param {number} cabinetNo - 柜号
   */
  async recoverLocker(cabinetNo) {
    if (!cabinetNo) return;
    
    try {
      const res = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "recoverLocker",
          cabinetNo: cabinetNo
        }
      });
      console.log(`柜号 ${cabinetNo} 恢复结果：`, res.result);
    } catch (e) {
      console.error(`柜号 ${cabinetNo} 恢复失败`, e);
    }
  },

  /**
   * 核心存包流程
   */
  async handleStoreItem() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });
    wx.showLoading({ title: '处理中...' });

    let lockerInfo = null;

    try {
      // 1. 参数验证
      if (!this.validateParams()) {
        setTimeout(() => wx.navigateBack({ delta: 1 }), this.constants.NAVIGATE_DELAY);
        return;
      }

      // 2. 获取可用柜子
      lockerInfo = await this.getAvailableCabinet();
      if (!lockerInfo) {
        setTimeout(() => wx.navigateBack({ delta: 1 }), this.constants.NAVIGATE_DELAY);
        return;
      }

      // 3. 创建订单
      const orderId = await this.createOrder(lockerInfo);
      if (!orderId) return;

      // 4. 支付确认
      const confirmPay = await this.showPaymentConfirmModal();
      if (!confirmPay) {
        await this.recoverLocker(lockerInfo.cabinetNo);
        wx.navigateBack({ delta: 1 });
        return;
      }

      // 5. 模拟支付
      wx.showLoading({ title: '模拟支付中...' });
      const paySuccess = await this.mockPaymentSuccess(orderId);
      if (!paySuccess) {
        wx.showToast({ title: '支付模拟失败', icon: 'none' });
        await this.recoverLocker(lockerInfo.cabinetNo);
        return;
      }

      // 6. 验证订单状态
      const isOrderValid = await this.verifyOrderStatus(orderId);
      if (!isOrderValid) {
        await this.recoverLocker(lockerInfo.cabinetNo);
        return;
      }

      // 7. 开柜操作
      wx.showLoading({ title: '打开柜门中...' });
      const openSuccess = await this.openCabinet(lockerInfo, orderId);
      
      if (openSuccess) {
        wx.hideLoading();
        wx.showToast({ 
          title: `支付成功，柜号 ${lockerInfo.cabinetNo} 已打开`, 
          icon: 'success',
          duration: 3000
        });
        setTimeout(() => {
          wx.navigateTo({
            url: `${this.constants.ORDER_DETAIL_PAGE}?orderId=${orderId}&cabinetNo=${lockerInfo.cabinetNo}`
          });
        }, 3000);
      } else {
        wx.hideLoading();
        wx.showToast({ title: '支付成功，开门失败', icon: 'none' });
        await this.recoverLocker(lockerInfo.cabinetNo);
      }
    } catch (e) {
      console.error("存包流程异常", e);
      wx.showToast({ title: '操作失败', icon: 'none' });
      if (lockerInfo) await this.recoverLocker(lockerInfo.cabinetNo);
    } finally {
      this.setData({ isLoading: false });
      wx.hideLoading();
    }
  },

  /**
   * 显示支付确认弹窗
   * @returns {Promise<boolean>} 用户是否确认支付
   */
  showPaymentConfirmModal() {
    return new Promise(resolve => {
      wx.showModal({
        title: '确认支付',
        content: `预支付金额：${this.data.display.totalPrepay}\n（测试模式，确认即视为支付成功）`,
        confirmText: '确认支付',
        cancelText: '取消',
        success: res => resolve(res.confirm)
      });
    });
  }
});
