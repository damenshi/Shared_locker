Page({
  data: {
    phone: '',       // 从首页传递的手机号
    code: '',        // 从首页传递的取件码
    cabinetNo: null,
    isLoading: false // 加载状态
  },

  onLoad(options) {
    // 接收首页传递的参数并验证
    const { phone = '', code = '', cabinetNo = null } = options;
    this.setData({ phone, code, cabinetNo});

    // 自动触发取件流程（参数完整时）
    if (phone && code) {
      this.handleTakeItem();
    } else {
      this.showError('请先输入手机号和取件码', () => {
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
  showSuccess(message, callback, duration = 2000) {
    wx.showToast({
      title: message,
      icon: 'success',
      duration
    });
    setTimeout(callback, duration);
  },

  /**
   * 验证输入格式
   * @returns {boolean} 验证结果
   */
  validateInput() {
    const { phone, code } = this.data;
    
    // 手机号验证（11位数字）
    if (!/^\d{11}$/.test(phone)) {
      wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' });
      return false;
    }
    
    // 取件码验证（4位数字）
    if (!/^\d{4}$/.test(code)) {
      wx.showToast({ title: '请输入4位取件码', icon: 'none' });
      return false;
    }
    
    return true;
  },

  /**
   * 查询匹配的订单（手机号+取件码）
   * @returns {Promise<Object|null>} 订单数据或null
   */
  async queryMatchedOrder() {
    try {
      const { phone, code, cabinetNo} = this.data;
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "queryByPhoneAndCode",
          phone,
          code,
          cabinetNo: cabinetNo? parseInt(cabinetNo):null
        }
      });

      // 检查云函数调用是否成功
      if (!res.result) {
        throw new Error('查询接口返回异常');
      }
      if (!res.result.success) {
        throw new Error(res.result.errMsg || '查询订单失败');
      }

      return res.result.data || null;
    } catch (e) {
      console.error("查询订单失败:", e);
      wx.showToast({ 
        title: `查询失败: ${e.message}`, 
        icon: 'none',
        duration: 3000
      });
      return null;
    }
  },

  /**
   * 取包打开柜门
   * @param {number} doorNo - 柜门
   * @param {string} orderId - 订单ID
   * @returns {Promise<boolean>} 开柜是否成功
   */
  async openCabinetDoor(doorNo, orderId, cabinetNo) {
    try {
      const res = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "openDoor",
          doorNo,
          orderId,
          cabinetNo,
          type: "take"
        }
      });

      console.log("开柜接口返回:", res.result);

      // 验证开柜结果
      if (!res.result || res.result.ok !== true) {
        throw new Error(res.result?.errMsg || '开柜失败，未知原因');
      }

      return true;
    } catch (e) {
      console.error("开柜操作失败:", e);
      wx.showToast({ 
        title: e.message, 
        icon: 'none',
        duration: 3000
      });
      return false;
    }
  },

  /**
   * 完成订单并释放柜子
   * @param {string} orderId - 订单ID
   * @returns {Promise<boolean>} 订单是否完成
   */
  async finishOrder(orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "finishOrder",
          orderId
        }
      });

      if (!res.result || !res.result.success) {
        throw new Error(res.result?.errMsg || '完成订单失败');
      }

      return true;
    } catch (e) {
      console.error("完成订单失败:", e);
      wx.showToast({ 
        title: `订单状态更新失败: ${e.message}`, 
        icon: 'none',
        duration: 3000
      });
      return false;
    }
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
        this.showError('参数错误', () => {
          wx.navigateBack({ delta: 1 });
        });
        return;
      }

      // 2. 查询匹配订单
      const order = await this.queryMatchedOrder();
      if (!order) {
        this.setData({ isLoading: false });
        wx.hideLoading();
        this.showError('未找到匹配的存包记录', () => {
          wx.navigateBack({ delta: 1 });
        });
        return;
      }

      // 3. 验证订单状态
      const validStatus = ['进行中', '已支付'];
      if (!validStatus.includes(order.status)) {
        this.setData({ isLoading: false });
        wx.hideLoading();
        this.showError(`订单状态异常：${order.status}`, () => {
          wx.navigateBack({ delta: 1 });
        });
        return;
      }

      // 4. 打开柜门
      const isDoorOpen = await this.openCabinetDoor(order.doorNo, order._id, order.cabinetNo);
      if (!isDoorOpen) {
        this.setData({ isLoading: false });
        wx.hideLoading();
        this.showError('柜门打开失败，请重试', () => {
          wx.navigateBack({ delta: 1 });
        });
        return;
      }

      // 5. 完成订单（即使失败也不影响用户取件）
      const isOrderFinished = await this.finishOrder(order._id);
      
      // 6. 处理最终结果
      wx.hideLoading();
      this.setData({ isLoading: false });

      if (isOrderFinished) {
        this.showSuccess(
          `取件成功，柜门 ${order.doorNo} 已打开`,
          () => { wx.navigateBack({ delta: 1 }); }
        );
      } else {
        // 订单状态更新失败但取件成功，仍提示成功
        this.showSuccess(
          `取件成功，柜门 ${order.doorNo} 已打开`,
          () => { wx.navigateBack({ delta: 1 }); }
        );
      }

    } catch (e) {
      console.error("取件流程异常:", e);
      this.setData({ isLoading: false });
      wx.hideLoading();
      this.showError(`系统错误: ${e.message}`, () => {
        wx.navigateBack({ delta: 1 });
      });
    }
  }
});