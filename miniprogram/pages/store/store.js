const app = getApp();
const plugin = requirePlugin("WechatSI");

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

  /**
   * 通用语音播报方法 (跨页面绝对防重叠)
   * @param {String} text 需要播报的文字 
   */
  playVoicePrompt(text) {
    // 1. 生成全局唯一递增的任务ID，防止跨页面的网络延迟导致“旧语音迟到”
    app.globalData.ttsTaskId = (app.globalData.ttsTaskId || 0) + 1;
    const currentTaskId = app.globalData.ttsTaskId;

    // 2. 将播放器挂载到 app.globalData 上，确保整个小程序只有这唯一的一个播放器
    if (!app.globalData.globalAudioCtx) {
      // 强制无视手机的“静音键/静音模式”
      if (wx.setInnerAudioOption) {
        wx.setInnerAudioOption({ obeyMuteSwitch: false });
      }
      app.globalData.globalAudioCtx = wx.createInnerAudioContext();
      app.globalData.globalAudioCtx.autoplay = true; 
      
      app.globalData.globalAudioCtx.onError((err) => {
        console.error('全局播报错误:', err);
      });
    }

    // 3. 不管现在在哪个页面，发起新请求前，立刻强行让全局播放器闭嘴！
    app.globalData.globalAudioCtx.stop();

    // 4. 发起语音合成网络请求
    plugin.textToSpeech({
      lang: "zh_CN",
      tts: true,
      content: text,
      success: (res) => {
        // 5. 等网络请求回来后，核对全局暗号。如果在这期间用户已经跳转页面并触发了新语音，果断丢弃！
        if (currentTaskId !== app.globalData.ttsTaskId) {
          console.log('跨页面拦截并丢弃过期语音:', text);
          return;
        }

        console.log('开始全局播报:', text);
        // 6. 塞入新的音频地址自动播放
        app.globalData.globalAudioCtx.src = res.filename; 
      },
      fail: (err) => {
        console.error("语音合成失败", err);
      }
    });
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
    // 扫码进入页面后播报
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
          cabinetNo: cabinetNo,
          orderId: orderId
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

  // 跳转到用户协议
  goToAgreement() {
    wx.navigateTo({
      // 指向你已经写好的用户协议页面
      url: '/pages/mine/agreement/userAgreement'
    });
  },

  // 跳转到隐私政策
  goToPrivacy() {
    // 如果你还没有单独的隐私政策页面，可以暂时让它也跳到用户协议页，或者建个新页面
    wx.navigateTo({
      url: '/pages/mine/agreement/userAgreement' 
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
    let retries = 20; // 20s
    while (retries-- > 0) {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getOrder', orderId }
      });

      if (res.result?.success) {
        const status = res.result.data?.status;
        
        // 【修改点2】明确成功
        if (status === this.data.constants.ORDER_STATUS_PROCESSING) {
          return true; 
        }
        
        // 【修改点3】明确失败（只有后端明确标记为取消/退款，前端才认作失败）
        if (['已取消', '已退款', '已完成'].includes(status)) {
          console.warn('后端返回明确的失败状态:', status);
          return false;
        }
      }
      await new Promise(r => setTimeout(r, 1000)); // 每 1 秒查一次
    }
    
    // 【修改点4】超时返回 null，而不是 false
    console.warn('查询支付结果超时');
    return null; 
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

    // 初始为 true，表示在支付成功前，如果有错可以回滚
    let canRecover = true;

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
        //检测到有进行中订单
        if(orderInfo.status == this.data.constants.ORDER_STATUS_PROCESSING){
          await new Promise((resolve, reject) => {
            wx.showModal({
              title: '提示',
              content: `检测到您在本机还有正在使用的柜门（${orderInfo.lockerNo}号）。是否先取出物品再继续存新包？`, 
              showCancel: true,
              cancelText: '取消',
              confirmText: '开旧柜',
              success: async (res) => {
                if (res.confirm) {
                  try {
                    wx.showLoading({ title: '正在打开旧柜门...' });

                    // 1. 直接调用后端的取件接口（后端会自动开门、释放柜子、结算订单）
                    const takeRes = await wx.cloud.callFunction({
                      name: 'locker',
                      data: {
                        action: 'openDoor',
                        deviceId: orderInfo.deviceId,
                        cabinetNo: orderInfo.cabinetNo,
                        doorNo: orderInfo.doorNo,
                        orderId: orderInfo._id, // 注意数据库的主键是 _id
                        type: 'take'
                      }
                    });

                    if (!takeRes.result?.success) {
                      throw new Error(takeRes.result?.errMsg || '旧柜门打开失败');
                    }

                    wx.hideLoading();

                    // 2. 旧门开了，给用户一个缓冲时间拿东西，拿完再继续分配新柜子
                    wx.showModal({
                      title: '旧柜门已开',
                      content: `请取出 ${orderInfo.lockerNo} 号柜内的物品并关好门。点击“继续”将立刻为您分配新的空柜子。`,
                      showCancel: false,
                      confirmText: '继续',
                      success: () => {
                        // 用户点继续，resolve 放行！代码会顺畅地走到下面的 createOrder 去分配新门
                        resolve();
                      }
                    });

                  } catch (err) {
                    wx.hideLoading();
                    wx.showToast({ title: err.message, icon: 'none', duration: 3000 });
                    reject(new Error('旧订单处理失败，已中断存包'));
                  }
                } else {
                  // 用户点击取消，拒绝执行，中断存包
                  reject(new Error('已取消操作'));
                }
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

      //占柜+创建订单二合一
      const orderRes = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "createOrder",
          password: this.data.password,
          deviceId: this.data.deviceId, // 注意：只需传 deviceId
          userInfo: userInfo
        }
      });
      
      if (!orderRes.result?.success) {
        throw new Error(orderRes.result?.errMsg || '分配柜门失败，请重试');
      }

      orderId = orderRes.result.data.orderId;
      lockerInfo = orderRes.result.data.lockerInfo;
      // 分配成功后播报
      this.playVoicePrompt(`已为您分配 ${lockerInfo.lockerNo} 号柜门`);

      // 5. 免费or付费
      const deviceConfig = await this.getDeviceDeposit(this.data.deviceId);
      const deviceDeposit = deviceConfig.deviceDeposit || 0;
      const isFree = deviceConfig.isFree || false; // 获取我们批量添加的字段

      let newDeposit = 0;
      
      if (isFree) {
        //免费模式 ---
        //开门前提示
        this.playVoicePrompt("正在为您开门，请稍后");
        wx.showLoading({ title: '正在开门...' });

        // 直接将订单状态更新为“进行中”，押金设为 0
        const updateOrderRes = await wx.cloud.callFunction({
          name: "order",
          data: {
            action: "updateOrder",
            orderId: orderId,
            status: this.data.constants.ORDER_STATUS_PROCESSING,
            deposit: 0
          }
        });

        if (!updateOrderRes.result?.success) 
          throw new Error('激活免费服务失败');
        
        canRecover = false; // 状态已更新，不再执行前端回滚
        newDeposit = 0;
        console.log('免费模式：已直接激活订单');

      } else {
        const confirmPay = await this.showPaymentConfirmModal(deviceDeposit, lockerInfo.lockerNo);
        if (!confirmPay) {
          throw new Error('未确认支付');
        }

        //支付
        wx.showLoading({ title: '处理中...' });
        const paySuccess = await this.payment(orderId, deviceDeposit);
        if (!paySuccess) {
          throw new Error('支付失败');
        }

        canRecover = false;
        const confirmed = await this.waitForPayment(orderId);
        // 【修改点3】处理超时情况 (confirmed === null)
        if (confirmed === null) {
          wx.hideLoading();
          // 仅仅提示用户，不做任何数据回滚
          wx.showModal({
            title: '提示',
            content: '系统正在确认支付结果，请稍后在“我的订单”中查看状态。如果柜门已开请正常使用。',
            showCancel: false,
            success: (res) => {
              if (res.confirm) wx.navigateBack({ delta: 1 });
            }
          });
          // 直接返回，跳过后续逻辑，也跳过 catch
          return;
        }
        // 处理明确失败的情况 
        if (confirmed === false) {
          // 后端已经明确是“已取消”，说明后端处理了异常
          // 我们只需要抛错提示用户，不需要前端再 recover（否则可能重复释放）
          throw new Error('开门失败');
        }
        newDeposit = deviceDeposit;
      }

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
      console.log('支付确认完成，后端已自动开门');

      //缓存手机号和密码
      await this.saveUserCredentials(this.data.openid, this.data.phone, this.data.password);
      
      const pages = getCurrentPages();
      const indexPage = pages.find(p => p.route === 'pages/index/index');
      if (indexPage) {
        indexPage.showOpenedLocker(lockerInfo.lockerNo);
      }

      wx.hideLoading();
      this.playVoicePrompt(`${lockerInfo.lockerNo}号柜门已打开，请存入物品并关好门`);
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

    } catch (e) {
      console.error("存包流程异常", e);
      // 【修改点4】关键：只有在允许回滚时才调用 recover
      if (canRecover) {
        console.warn('触发前端自动回滚逻辑');
        if (lockerInfo) await this.recoverLocker(lockerInfo.deviceId, lockerInfo.doorNo, lockerInfo.cabinetNo, orderId);
        if (orderId) await this.recoverOrder(orderId);
      } else {
        console.warn('支付已提交，跳过前端自动回滚，交由后端兜底');
      }

       // 根据错误信息弹窗提示
      let showMsg = e.message || '开柜失败，请重试';
      // 如果错误信息包含 'cloud.callFunction' 或 'fail' 等系统关键词，强制替换为友好提示
      if (showMsg.includes('cloud.callFunction') || showMsg.includes('fail')) {
        showMsg = '网络或设备异常，请重试';
      }

      if (!canRecover) {
        showMsg += '\n(如已扣款请在“我的订单”查看状态)';
      }
      const finalMsg = `${showMsg}\n\n如有疑问请拨打客服电话400-832-6132`;

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
    } finally {
      this.setData({ isLoading: false });
      wx.hideLoading();
    }
  }
});
