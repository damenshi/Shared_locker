Page({
  data: {
    phone: '',       // 从首页传递的手机号
    code: '',        // 从首页传递的取件码
    isLoading: false // 加载状态
  },

  onLoad(options) {
    // 接收首页传递的手机号和取件码（无需用户再次输入）
    this.setData({
      phone: options.phone || '',
      code: options.code || ''
    });

    // 自动触发取件流程（如果参数完整）
    if (this.data.phone && this.data.code) {
      this.handleTakeItem();
    } else {
      wx.showToast({ title: '请先输入手机号和取件码', icon: 'none' });
      // 2秒后返回首页
      setTimeout(() => {
        wx.navigateBack({ delta: 1 });
      }, 2000);
    }
  },

  // 验证输入格式（复用首页已输入的参数）
  validateInput() {
    if (!/^\d{11}$/.test(this.data.phone)) {
      wx.showToast({ title: '手机号不正确', icon: 'none' });
      return false;
    }
    if (!this.data.code || this.data.code.length !== 6) {
      wx.showToast({ title: '取件码必须是6位数字', icon: 'none' });
      return false;
    }
    return true;
  },

  // 查询匹配的订单（手机号+取件码）
  async queryMatchedOrder() {
    try {
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "queryByPhoneAndCode",
          phone: this.data.phone,
          code: this.data.code
        }
      });
      return res.result.data || null;
    } catch (e) {
      console.error("查询订单失败", e);
      wx.showToast({ title: '查询订单异常', icon: 'none' });
      return null;
    }
  },

  // 取包打开柜门
  async openCabinetDoor(cabinetNo, orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "openDoor",
          cabinetNo: cabinetNo,
          orderId: orderId,
          type: "take"
        }
      });
      // 打印完整返回结果，便于调试
      console.log("取包开柜接口返回:", res.result);
      
      // 严格判断成功状态
      if (res.result && res.result.ok === true) {
        return true;
      } else {
        // 显示云函数返回的具体错误原因
        wx.showToast({ 
          title: `开柜失败: ${res.result?.errMsg || '未知错误'}`, 
          icon: 'none',
          duration: 3000
        });
        return false;
      }
    } catch (e) {
      console.error("开门失败", e);
      return false;
    }
  },

  // 完成订单并释放柜子
  async finishOrder(orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "finishOrder",
          orderId: orderId
        }
      });
      return res.result.success;
    } catch (e) {
      console.error("完成订单失败", e);
      return false;
    }
  },

  // 核心取件逻辑（自动触发）
  async handleTakeItem() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });
    wx.showLoading({ title: '正在验证取件信息...' });

    try {
      // 1. 验证参数
      if (!this.validateInput()) {
        this.setData({ isLoading: false });
        wx.hideLoading();
        // 参数错误时返回首页
        setTimeout(() => {
          wx.navigateBack({ delta: 1 });
        }, 2000);
        return;
      }

      // 2. 查询订单
      const order = await this.queryMatchedOrder();
      if (!order) {
        wx.hideLoading();
        wx.showToast({ title: '未找到匹配的存包记录', icon: 'none' });
        this.setData({ isLoading: false });
        setTimeout(() => {
          wx.navigateBack({ delta: 1 });
        }, 2000);
        return;
      }

      // 3. 验证订单状态
      if (!['进行中', '已支付'].includes(order.status)) {
        wx.hideLoading();
        wx.showToast({ title: `订单状态异常：${order.status}`, icon: 'none' });
        this.setData({ isLoading: false });
        setTimeout(() => {
          wx.navigateBack({ delta: 1 });
        }, 2000);
        return;
      }

      // 4. 打开柜门
      const isDoorOpen = await this.openCabinetDoor(order.cabinetNo, order._id);
      if (!isDoorOpen) {
        wx.hideLoading();
        wx.showToast({ title: '柜门打开失败', icon: 'none' });
        this.setData({ isLoading: false });
        return;
      }

      // 5. 完成订单
      const isOrderFinished = await this.finishOrder(order._id);
      if (isOrderFinished) {
        wx.hideLoading();
        wx.showToast({ title: '取件成功，，柜号 ${order.cabinetNo} 已打开', 
        icon: 'success', 
        duration: 2000 });
        // 取件成功后返回首页
        setTimeout(() => {
          wx.navigateBack({ delta: 1 });
        }, 2000);
      } else {
        wx.hideLoading();
        wx.showToast({ title: '取件成功，订单状态更新失败', icon: 'none' });
        setTimeout(() => {
          wx.navigateBack({ delta: 1 });
        }, 2000);
      }
    } catch (e) {
      console.error("取件失败", e);
      wx.hideLoading();
      wx.showToast({ title: '系统错误', icon: 'none' });
      this.setData({ isLoading: false });
    }
  }
});