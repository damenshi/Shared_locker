Page({
  data: {
    rules: {},
    display: {},
    currentOrderId: null,
    isLoading: false,
    phone: '',       // 从首页传递的手机号
    code: ''         // 从首页传递的取件码
  },

  onLoad(options) {
    // 接收首页传递的参数
    this.setData({
      phone: options.phone || '',
      code: options.code || ''
    });
    this.loadRules();
    // 延迟执行存包流程，避免规则未加载完成
    setTimeout(() => this.handleStoreItem(), 500);
  },

  // 加载计费规则（增加默认值处理）
  async loadRules() {
    try {
      const res = await wx.cloud.callFunction({ 
        name: "billing", 
        data: { action: "getRules" } 
      });
      const rules = res.result.data || {};

      const display = {
        free: `免费${rules.freeMinutes || 15}分钟`,
        first: `首${rules.firstPeriodMinutes || 60}分钟￥${((rules.firstPeriodPrice || 300) / 100).toFixed(2)}`,
        unit: `续费每${rules.unitMinutes || 30}分钟￥${((rules.unitPrice || 100) / 100).toFixed(2)}`,
        cap: `封顶￥${((rules.capPrice || 2000) / 100).toFixed(2)}`,
        deposit: `押金￥${((rules.depositPrice || 500) / 100).toFixed(2)}`,
        totalPrepay: `预支付:￥${(((rules.firstPeriodPrice || 300) + (rules.depositPrice || 500)) / 100).toFixed(2)}`
      };

      this.setData({ rules, display });
    } catch (e) {
      console.error("获取计费规则失败", e);
      // 加载失败时使用默认规则
      this.setData({
        rules: {
          freeMinutes: 15,
          firstPeriodMinutes: 60,
          firstPeriodPrice: 300,
          unitMinutes: 30,
          unitPrice: 100,
          capPrice: 2000,
          depositPrice: 500
        },
        display: {
          free: '免费15分钟',
          first: '首60分钟￥3.00',
          unit: '续费每30分钟￥1.00',
          cap: '封顶￥20.00',
          deposit: '押金￥5.00',
          totalPrepay: '预支付:￥8.00'
        }
      });
    }
  },

  // 查询可用柜子（严格过滤有效柜子）
  async getAvailableCabinet() {
    try {
      const res = await wx.cloud.callFunction({
        name: "locker",
        data: { action: "listFree" }
      });
      
      if (res.result.success && res.result.data.length > 0) {
        // 过滤状态为free且无关联订单的柜子
        const validLockers = res.result.data.filter(locker => 
          locker.status === 'free' && locker.currentOrderId === null
        );
        if (validLockers.length > 0) {
          return validLockers[0];
        } else {
          wx.showToast({ title: '暂无可用柜子', icon: 'none' });
          return null;
        }
      } else {
        wx.showToast({ title: '暂无可用柜子', icon: 'none' });
        return null;
      }
    } catch (e) {
      console.error("查询可用柜失败", e);
      return null;
    }
  },

  // 创建订单（保持不变）
  async createOrder(lockerInfo) {
    try {
      // 验证参数
      if (!this.data.phone || !/^\d{11}$/.test(this.data.phone)) {
        wx.showToast({ title: '手机号不正确', icon: 'none' });
        return null;
      }
      if (!this.data.code || this.data.code.length !== 6) {
        wx.showToast({ title: '请输入6位取件码', icon: 'none' });
        return null;
      }

      // 调用云函数创建订单
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "createOrder",
          lockerId: lockerInfo._id,
          phone: this.data.phone,
          code: this.data.code
        }
      });

      if (res.result && res.result.orderId) {
        this.setData({ currentOrderId: res.result.orderId });
        return res.result.orderId;
      } else if (res.result && res.result.error) {
        wx.showToast({ title: `创建失败: ${res.result.error}`, icon: 'none', duration: 3000 });
        return null;
      } else {
        wx.showToast({ title: '创建订单失败', icon: 'none' });
        return null;
      }
    } catch (e) {
      console.error("创建订单异常", e);
      return null;
    }
  },

  // 模拟支付成功（保持不变）
  async mockPaymentSuccess(orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "mockPaySuccess",
          orderId: orderId
        }
      });
      return res.result.success;
    } catch (e) {
      console.error("模拟支付失败", e);
      return false;
    }
  },

  // 打开柜门（精确判断开柜结果）
  async openCabinet(lockerInfo, orderId) {
    try {
      const openRes = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "openDoor",
          cabinetNo: lockerInfo.cabinetNo,
          orderId: orderId,
          type: "store"
        }
      });
      // 打印完整返回结果，定位具体错误
      console.log("开柜接口返回结果：", openRes.result);
      // 仅当返回ok为true时视为成功
      return openRes.result && openRes.result.ok === true;
    } catch (e) {
      console.error("开门失败", e);
      return false;
    }
  },

  // 恢复柜子状态（增加日志输出）
  async recoverLocker(cabinetNo) {
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
      console.error("恢复柜子状态失败", e);
    }
  },

  // 存包流程（优化订单状态校验）
  async handleStoreItem() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });
    wx.showLoading({ title: '处理中...' });

    let lockerInfo = null;

    try {
      // 1. 验证参数
      if (!this.data.phone || !this.data.code) {
        wx.hideLoading();
        wx.showToast({ title: '请先输入手机号和取件码', icon: 'none' });
        setTimeout(() => wx.navigateBack({ delta: 1 }), 2000);
        return;
      }

      // 2. 获取可用柜子
      lockerInfo = await this.getAvailableCabinet();
      if (!lockerInfo) {
        wx.hideLoading();
        setTimeout(() => wx.navigateBack({ delta: 1 }), 2000);
        return;
      }

      // 3. 创建订单
      const orderId = await this.createOrder(lockerInfo);
      if (!orderId) {
        wx.hideLoading();
        await this.recoverLocker(lockerInfo.cabinetNo);
        return;
      }

      // 4. 显示支付确认弹窗
      wx.hideLoading();
      const confirmPay = await new Promise(resolve => {
        wx.showModal({
          title: '模拟支付',
          content: `预支付金额：${this.data.display.totalPrepay}\n（个人账号测试模式，点击"确认支付"即视为支付成功）`,
          confirmText: '确认支付',
          cancelText: '取消',
          success: res => resolve(res.confirm)
        });
      });

      if (!confirmPay) {
        await this.recoverLocker(lockerInfo.cabinetNo);
        wx.navigateBack({ delta: 1 });
        return;
      }

      // 5. 模拟支付
      wx.showLoading({ title: '模拟支付中...' });
      const paySuccess = await this.mockPaymentSuccess(orderId);
      if (!paySuccess) {
        wx.hideLoading();
        wx.showToast({ title: '支付模拟失败', icon: 'none' });
        await this.recoverLocker(lockerInfo.cabinetNo);
        return;
      }

      // 6. 订单状态校验（匹配订单云函数的状态）
      const orderStatusRes = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "getOrder",  // 使用getOrder接口查询订单
          id: orderId
        }
      });
      
      // 先判断数据是否存在
      if (!orderStatusRes.result || !orderStatusRes.result.data) {
        wx.hideLoading();
        wx.showToast({ title: '查询订单失败', icon: 'none' });
        await this.recoverLocker(lockerInfo.cabinetNo);
        return;
      }

      // 订单支付后状态应为"进行中"（与订单云函数一致）
      if (orderStatusRes.result.data.status !== '进行中') {
        wx.hideLoading();
        wx.showToast({ 
          title: `订单状态异常（当前：${orderStatusRes.result.data.status}）`, 
          icon: 'none' 
        });
        await this.recoverLocker(lockerInfo.cabinetNo);
        return;
      }

      // 7. 开柜
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
            url: `/pages/orderDetail/orderDetail?orderId=${orderId}&cabinetNo=${lockerInfo.cabinetNo}`
          });
        }, 3000);
      } else {
        wx.hideLoading();
        wx.showToast({ title: '支付成功，开门失败', icon: 'none' });
        await this.recoverLocker(lockerInfo.cabinetNo);
      }
    } catch (e) {
      console.error("存包流程异常", e);
      wx.hideLoading();
      wx.showToast({ title: '操作失败', icon: 'none' });
      if (lockerInfo) {
        await this.recoverLocker(lockerInfo.cabinetNo);
      }
    } finally {
      this.setData({ isLoading: false });
    }
  }
});