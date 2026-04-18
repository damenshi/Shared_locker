const db = wx.cloud.database()
const app = getApp();
const plugin = requirePlugin("WechatSI");

Page({
  data: {
    phone: '',
    password: '',
    openid: '',
    deviceId: null,
    deviceAddress: '',
    freeDoorCnt: '',
    canProceed: false,
    showLockerBox: false, 
    openedLockerNo: '',       // 显示开柜号
    showConfirmModal: false
  },
  
  /**
   * 全局终极版：通用语音播报方法 (跨页面绝对防重叠)
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
    // 动态设置页面标题
    const miniName = app.globalData.miniName || '储物柜';
    wx.setNavigationBarTitle({ title: miniName });

    if (options && options.query && options.query.deviceId) {
      app.globalData.deviceId = options.query.deviceId;
      console.log('[index] 从扫码参数更新 deviceId:', options.query.deviceId);
    }

    // 每次重新获取设备信息
    app.getDevAddress();
    app.getFreeDoorCnt();

    if (app.globalData.deviceAddress) {
      this.setData({
        deviceAddress: app.globalData.deviceAddress
      });
    } else {
      app.globalData.addressReadyCallback = (address) => {
        this.setData({ deviceAddress: address });
      };
    }

    if (app.globalData.freeDoorCnt) {
      this.setData({
        freeDoorCnt: app.globalData.freeDoorCnt
      });
    } else {
      app.globalData.freedoorReadyCallback = (freeCnt) => {
        this.setData({ freeDoorCnt: freeCnt });
      };
    }

    setTimeout(() => {
      this.playVoicePrompt(`欢迎使用${miniName}，请输入手机号和取件码`);
    }, 500);
  },

  onUnload() {
    app.globalData.addressReadyCallback = null;
    app.globalData.freedoorReadyCallback = null;
  },

  // onShow() {
  //   this.setData({
  //     openid: app.globalData.openid || '',
  //     deviceId: app.globalData.deviceId || '',
  //   });

  //   const showLockerBox = wx.getStorageSync('showLockerBox');
  //   const openedLockerNo = wx.getStorageSync('openedLockerNo');
  //   if (showLockerBox) {
  //     this.setData({
  //       showLockerBox,
  //       openedLockerNo
  //     });
  //   }
  // },

  onShow() {
    this.setData({
      openid: app.globalData.openid || '',
      deviceId: app.globalData.deviceId || '',
    });

    // 1. 获取缓存中的显示状态和时间
    const showLockerBox = wx.getStorageSync('showLockerBox');
    const openedLockerNo = wx.getStorageSync('openedLockerNo');
    const lockerShowTime = wx.getStorageSync('lockerShowTime') || 0;

    // 2. 定义超时时间 (24小时)
    const EXPIRE_TIME = 24 * 60 * 60 * 1000;

    const now = Date.now();

    if (showLockerBox) {
      // 3. 核心判断：如果距离上次显示已经超过 24 小时
      if (now - lockerShowTime > EXPIRE_TIME) {
        // === 超时处理 ===
        console.log('柜门显示状态已超时(超过1天)，自动隐藏');
        
        // (1) 清除页面数据，隐藏UI
        this.setData({
          showLockerBox: false,
          openedLockerNo: ''
        });

        //清除过期缓存，防止下次进来还显示
        wx.removeStorageSync('showLockerBox');
        wx.removeStorageSync('openedLockerNo');
        wx.removeStorageSync('lockerShowTime');
      } else {
        // === 未超时 ===
        // 正常恢复显示
        this.setData({
          showLockerBox: true,
          openedLockerNo: openedLockerNo
        });
      }
    }
  },

  async getPhoneNumber(e) {
    if (e.detail.errMsg !== "getPhoneNumber:ok") {
      wx.showToast({ title: '用户拒绝授权', icon: 'none' })
      return
    }

    try {
      // 第一步：登录获取 code
      const loginRes = await wx.login()
      const code = loginRes.code

      // 第二步：传 encryptedData、iv、code 给云函数
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: {
          action: 'getPhone',
          code,
          encryptedData: e.detail.encryptedData,
          iv: e.detail.iv
        }
      })

      const phone = res.result?.phoneNumber;

      if (phone) {
        this.setData({ phone });
        this.checkCanProceed?.();
      } else {
        wx.showToast({ title: "获取手机号失败", icon: "none" });
      }
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '获取失败', icon: 'none' })
    }
  },

  //显示打开柜号
  showOpenedLocker(lockerNo) {
    this.setData({
      showLockerBox: true,
      openedLockerNo: lockerNo
    });

    wx.setStorageSync('lockerShowTime', Date.now());
    wx.setStorageSync('showLockerBox', true);
    wx.setStorageSync('openedLockerNo', lockerNo);
  },

   // 点击中途开柜按钮
   async midopenLocker() {
    if (!this.data.openedLockerNo || !this.data.deviceId) return;

    wx.showLoading('中途开门...');

    try{

      const matchOrder = await wx.cloud.callFunction({
        name: "order",
        data: {
          action: "queryByOpenid",
          openid: this.data.openid,
          deviceId: this.data.deviceId
        }
      });
      if (!matchOrder.result?.success) 
        throw new Error('查询用户订单失败');
      const order = matchOrder.result.data;

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

      const isDoorOpen = await wx.cloud.callFunction({
        name: "locker",
        data: {
          action: "openDoor",
          deviceId: order.deviceId,
          doorNo: order.doorNo,
          orderId: order._id,
          cabinetNo: order.cabinetNo,
          type: "store"
        }
      });
      if (!isDoorOpen.result?.success){
        this.setData({ isLoading: false });
        wx.hideLoading();
        this.showError('中途开门失败，请重试', () => {
          wx.navigateBack({ delta: 1 });
        });
        throw new Error('中途开门失败');
      }

      wx.hideLoading();

      wx.showToast({ title: '柜门已打开', icon: 'success' });
    }catch (err) {
      wx.hideLoading();
      console.error('中途开门失败：', err);
      wx.showToast({ title: '订单已结束，中途开门失败', icon: 'none' });
    }
  },

  finishUse() {
    wx.navigateTo({
      url: '/pages/take/take'
    })
  },

  // 监听手机号输入
  onPhoneInput(e) {
    const phone = e.detail.value;
    this.setData({
      phone: phone
    });
    this.checkCanProceed();
  },

  // 监听密码输入
  onPasswordInput(e) {
    const pwd = e.detail.value;
    this.setData({
      password: pwd
    });
    this.checkCanProceed();
  },

  // 检查是否可以进入下一步
  checkCanProceed() {
    const { phone, password } = this.data;
    // 手机号11位，密码4位
    const canProceed = phone.length === 11 && password.length === 4;
    this.setData({
      canProceed: canProceed
    });
  },

  // 前往下一步（支付页面）
  goToNextPage() {
    const { phone, password } = this.data;
    if (!phone || !password) {
      wx.showToast({ title: '请填写手机号和取件码', icon: 'none' });
      return;
    }
    
    //弹出确认框时的防呆语音警告
    this.playVoicePrompt("请仔细核对手机号和取件码。若填写错误，将无法开柜取件。");

    // 显示自定义确认弹窗
    this.setData({ showConfirmModal: true });
  },
  
  // 点击确认按钮
  handleConfirmNext() {
    const { phone, password } = this.data;
    wx.setStorageSync('phone', phone);
    wx.setStorageSync('password', password);
  
    wx.navigateTo({
      url: `/pages/store/store?phone=${phone}&password=${password}`
    });
  
    this.setData({ showConfirmModal: false });
  },
  
  // 点击取消按钮
  handleCancelConfirm() {
    wx.showToast({ title: '请检查信息后再操作', icon: 'none', duration: 1500 });
    this.setData({ showConfirmModal: false });
  }
  
});
