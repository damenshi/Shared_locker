const app = getApp();

Page({
  data: {
    phone: '',       // 手机号
    password: '',        // 取件码
    openid: '',
    isLoading: false,
    deviceId: '',
    showPayModal: false,
    payDeposit: 0,        
    lockerNo: '',
    constants: {
      ORDER_STATUS_PROCESSING: '进行中',
      NAVIGATE_DELAY: 2000,
    }
  },

  onLoad(options) {
    // 接收并验证首页传递的参数
    this.setData({
      phone: options.phone || '',
      password: options.password || '',
      openid: app.globalData.openid || '',
      deviceId: app.globalData.deviceId || '',
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

  async saveUserCredentials(openid, phone, password) {
    try {
      const userCache = wx.getStorageSync('userCredentials') || {};
      userCache[openid] = { phone, password };
      wx.setStorageSync('userCredentials', userCache);
      console.log('手机号密码已缓存', userCache[openid]);
    } catch (err) {
      console.error('缓存失败:', err);
    }
  },
  
  // 获取用户余额
  async getUserDeposit(openid) {
    const res = await wx.cloud.callFunction({
      name: "user",
      data: {
        action: "getDeposit",
        openid: openid
      }
    });
    console.log("getUserDeposit res.result.data", res.result.data);
    if(res.result?.success)
      return res.result.data;
    else{
      wx.showToast({ title: '用户账户异常', icon: 'none' });
      return null;
    }
  },

  // 获取设备收费标准
  async getDeviceDeposit(deviceId) {
    const res = await wx.cloud.callFunction({
      name: "device",
      data: {
        action: "getDevicesDeposit",
        deviceId: deviceId
      }
    });
    console.log("getDeviceDeposi: ", res.result.data);
    if(res.result?.success){
      return res.result.data;
    } else {
      wx.showToast({ title: '设备异常', icon: 'none' });
      return null;
    }

  },

  /**
   * 模拟支付成功
   * @param {string} orderId - 订单ID
   * @returns {boolean} 支付是否成功
   */
  async mockPaymentSuccess(orderId, deviceDeposit) {
    try {
      const res = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "mockPaySuccess",
          orderId: orderId,
          deviceDeposit: deviceDeposit
        }
      });
      return !!res.result?.success;
    } catch (e) {
      console.error("模拟支付失败", e);
      return false;
    }
  },

  async payment(orderId, deviceDeposit) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: {
          action: 'createPrepay',
          orderId: orderId,
          amount: Math.round(deviceDeposit * 100),
          openid: this.data.openid
        }
      });
  
      if (!res.result?.success || !res.result.data) {
        throw new Error('createPrepay failed');
      }
  
      const payParams = res.result.data; // { timeStamp, nonceStr, package, signType, paySign }
  
      // 2) 调起微信支付
      return await new Promise((resolve) => {
        wx.requestPayment({
          timeStamp: String(payParams.timeStamp),
          nonceStr: payParams.nonceStr,
          package: payParams.package, // 格式: prepay_id=xxx
          signType: payParams.signType || 'RSA',
          paySign: payParams.paySign,
          success: (r) => {
            console.log('wx.requestPayment success', r);
            // 注意：虽然请求返回 success，但最终订单以服务器端异步回调为准。
            // 可以在这里简单返回 true，并依赖后端回调来最终更新状态。
            resolve(true);
          },
          fail: (err) => {
            console.error('wx.requestPayment fail', err);
            wx.showToast({ title: '支付未完成', icon: 'none' });
            resolve(false);
          }
        });
      });
  
    } catch (e) {
      console.error('realPayment error', e);
      wx.showToast({ title: '支付异常', icon: 'none' });
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

   //自定义支付确认弹窗
   showPaymentConfirmModal(deviceDeposit, lockerNo) {
    return new Promise(resolve => {
      wx.hideLoading();
      this.setData({
        showPayModal: true,
        payDeposit: deviceDeposit,
        lockerNo: lockerNo,
        _resolvePay: resolve 
      });
    });
  },

  //用户点击确认支付
  confirmPay() {
    if (this.data._resolvePay) {
      this.data._resolvePay(true);
    }
    this.setData({ showPayModal: false, _resolvePay: null });
  },

  //用户点击取消
  cancelPay() {
    if (this.data._resolvePay) {
      this.data._resolvePay(false);
    }
    this.setData({ showPayModal: false, _resolvePay: null });
  },

  async waitForPayment(orderId) {
    let retries = 10; // 最多查询 5次
    while (retries-- > 0) {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getOrder', orderId }
      });
      if (res.result?.success && res.result.data?.status === this.data.constants.ORDER_STATUS_PROCESSING) {
        return true; // 支付已确认
      }
      await new Promise(r => setTimeout(r, 1000)); // 每 1 秒查一次
    }
    return false; // 超时
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
        throw new Error('请输入手机号和取件码');
      }

      //2.检查是否有进行中的订单
      const checkRes = await wx.cloud.callFunction({
        name: "order",
        data: { 
          action: "queryByOpenid",
          openid: this.data.openid,
          deviceId: this.data.deviceId
        } 
      });
      if (checkRes.result?.success){
        const orderInfo = checkRes.result.data;
        if(orderInfo.status == this.data.constants.ORDER_STATUS_PROCESSING){
          await new Promise((resolve, reject) => {
            wx.showModal({
              title: '提示',
              content: '已有进行中订单，是否继续创建新订单？', // 询问内容
              showCancel: true,       // 显示取消按钮
              cancelText: '取消',     // 左边按钮
              confirmText: '继续',    // 右边按钮
              success: (res) => {
                if (res.confirm) {
                  // 用户点击“继续”，解决 Promise，代码继续向下执行
                  resolve();
                } else {
                  // 用户点击“取消”，拒绝 Promise，触发 catch 流程
                  reject(new Error('有进行中订单，请先取件结束订单后再存包'));
                }
              },
              fail: () => {
                // 异常情况也视为取消
                reject(new Error('操作取消'));
              }
            });
          });
        }
      }

      //4.创建/获取用户账户      
      const userRes = await wx.cloud.callFunction({
        name: 'user',
        data: {
          action: 'createUser',
          openid: this.data.openid,
          phone: this.data.phone,
        }
      });
      if (!userRes.result?.success) throw new Error('无相关用户信息');
      const userInfo = userRes.result.data;

      //3.获取可用柜子并占用
      const freeRes = await wx.cloud.callFunction({
        name: 'locker',
        data: {
          action: 'listFree',
          deviceId: this.data.deviceId
        }
      });
  
      if (!freeRes.result?.success) 
        throw new Error('无空闲柜门');
      lockerInfo = freeRes.result.data;

      // 4. 创建订单
      const orderRes = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "createOrder",
          password: this.data.password,
          lockerInfo: lockerInfo,
          userInfo: userInfo
        }
      });
      if (!orderRes.result?.success) throw new Error('创建订单失败');
      orderId = orderRes.result.data;

      //5.更新柜子相关信息
      const updateRes = await wx.cloud.callFunction({
        name: 'locker',
        data: {
          action: 'updateLocker',
          lockerId: lockerInfo._id,
          currentOrderId: orderId,
          currentUserPhone: userInfo.phone
        }
      });
      if (!updateRes.result?.success) 
        throw new Error('更新柜子当前订单失败');

      // 5. 查询用户是否有余额
      // const userDeposit = await this.getUserDeposit(this.data.openid);
      const deviceDeposit = await this.getDeviceDeposit(this.data.deviceId);
      let newDeposit = 0;
      // if (userDeposit >= deviceDeposit) {
      //   wx.showToast({ title: '余额充足，无需支付', icon: 'none', duration: 2000});
      //   //更新订单状态为进行中并更新付款金额
      //   const updateOrderRes = await wx.cloud.callFunction({
      //     name: "order",
      //     data: {
      //       action: "updateOrder",
      //       orderId: orderId,
      //       status: this.data.constants.ORDER_STATUS_PROCESSING,
      //       deposit: newDeposit
      //     }
      //   });
      //   if (!updateOrderRes.result?.success) 
      //     throw new Error('更新订单状态为进行中失败');
        
      // } else {
        // 每次支付押金
        const confirmPay = await this.showPaymentConfirmModal(lockerInfo.deviceDeposit, lockerInfo.lockerNo);
        if (!confirmPay) {
          throw new Error('未确认支付');
        }

        //支付
        wx.showLoading({ title: '支付预付费用...' });
        const paySuccess = await this.payment(orderId, lockerInfo.deviceDeposit);
        if (!paySuccess) {
          throw new Error('支付失败');
        }
        const confirmed = await this.waitForPayment(orderId);
        if (!confirmed) 
          throw new Error('支付结果未确认');
        newDeposit = deviceDeposit;
      //}

      // 7.更新用户余额
      const userUpdate = await wx.cloud.callFunction({
        name: 'user',
        data: {
          action: 'updateUser',
          openid: this.data.openid,
          deposit: newDeposit,
        }
      });
      if (!userUpdate.result?.success) 
        throw new Error('更新用户余额失败');

      // 8. 开柜操作
      wx.showLoading({ title: '打开柜门中...' });
      // const openSuccess = await this.openCabinet(lockerInfo, orderId);
      const openDoorRes = await wx.cloud.callFunction({
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

      if (!openDoorRes.result?.success){
        wx.hideLoading();
        throw new Error('开门失败，请重试');
      }else{
        //缓存手机号和密码
        await this.saveUserCredentials(this.data.openid, this.data.phone, this.data.password);

        const pages = getCurrentPages();
        const indexPage = pages.find(p => p.route === 'pages/index/index');
        if (indexPage) {
          indexPage.showOpenedLocker(lockerInfo.lockerNo);
        }
  
        wx.hideLoading();
        wx.showModal({
          title: '提示',
          content: `柜门 ${lockerInfo.lockerNo} 已打开`,
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

    } catch (e) {
      console.error("存包流程异常", e);
      if (lockerInfo) await this.recoverLocker(lockerInfo.deviceId, lockerInfo.doorNo, lockerInfo.cabinetNo);
      if (orderId) await this.recoverOrder(orderId);

       // 根据错误信息弹窗提示
      const msg = e.message || '开柜失败，订单已取消，请重试';

      wx.showModal({
        title: '提示',
        content: msg,
        showCancel: false,
        confirmText: '好的',
        success: (res) => {
          if (res.confirm) {
            // 用户点击了“好的”
            wx.navigateBack({ delta: 1 });
          }
        }
      });
    } finally {
      this.setData({ isLoading: false });
      wx.hideLoading();
    }
  }
});
