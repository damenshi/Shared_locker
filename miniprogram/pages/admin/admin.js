Page({
  data: {
    // 用户订单管理相关
    userPhone: '',

    // 设备订单管理相关
    internalNo_ord: '',
    lockerNo_ord: '',

    // 柜门控制相关
    internalNo_ctl: '',
    lockerNo: '',

    // 批量生成储物柜相关
    internalNo: '',
    cabinetCount: '',
    lockersPerCabinet: '',
    unitPrice: '',
    screenNo: '',
    deviceAddress: '',
    deviceDeposit: '',
    delayedRefundOptions: ['否', '是'],
    delayedRefundIndex: 0,

    // 加载状态
    loading: false,

    // 免费模式状态
    isFreeMode: false,

    // 商户列表
    merchantList: []
  },

  // 输入框变化处理
  onInputChange(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [field]: e.detail.value });
  },

  // 延迟退款选项变化
  onDelayedRefundChange(e) {
    this.setData({
      delayedRefundIndex: e.detail.value
    });
  },

  // 显示加载提示
  showLoading(title = '处理中...') {
    this.setData({ loading: true });
    wx.showLoading({ title });
  },

  // 隐藏加载提示
  hideLoading() {
    this.setData({ loading: false });
    wx.hideLoading();
  },

  // 3. 远程打开柜门
  async openAnyDoor() {
    const {internalNo_ctl, lockerNo} = this.data;
    
    if (!internalNo_ctl || !lockerNo) {
      return wx.showToast({ title: '请输入设备编号和柜门编号', icon: 'none' });
    }

    this.showLoading('正在开门...');
    
    try {
      const result = await wx.cloud.callFunction({
        name: 'locker',
        data: {
          action: 'openDoorByAdmin',
          internalNo: internalNo_ctl,
          lockerNo: parseInt(lockerNo)
        }
      });

      this.hideLoading();
      
      if (!result.result.success)
        throw new Error('开门失败，设备不在线');
      wx.showToast({ title: '柜门已打开', icon: 'success' });
      
    } catch (err) {
      this.hideLoading();
      console.error('开门失败：', err);
      wx.showToast({ title: '开门失败，设备不在线', icon: 'none' });
    }
  },
  
  //配置设备
  async batchCreateLockersByDevice() {
    const { internalNo, deviceAddress, deviceDeposit, unitPrice, delayedRefundIndex, screenNo, cabinetCount, lockersPerCabinet } = this.data;

    if (!deviceAddress || !internalNo || cabinetCount <= 0 || lockersPerCabinet <= 0) {
      return wx.showToast({
        title: '请填写完整的设备配置信息',
        icon: 'none'
      });
    }

    const delayedRefund = delayedRefundIndex === 1;
    this.showLoading('配置设备中...');
    
    try {
      const result = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'batchCreateLockers',
          internalNo: internalNo, // 指定设备ID
          deviceAddress: deviceAddress,
          deviceDeposit: parseInt(deviceDeposit),
          unitPrice: parseInt(unitPrice),
          delayedRefund: delayedRefund || false,
          screenNo: parseInt(screenNo),
          cabinetCount: parseInt(cabinetCount),
          lockersPerCabinet: parseInt(lockersPerCabinet)
        }
      });

      this.hideLoading();
      
      if (result.result.success) {
        wx.showToast({
          title: `成功生成 ${result.result.count} 个锁具`,
          icon: 'success',
          duration: 2000
        });
      } else {
        wx.showToast({
          title: result.result.errMsg || '生成失败',
          icon: 'none'
        });
      }
    } catch (err) {
      this.hideLoading();
      console.error('批量生成锁具失败：', err);
      wx.showToast({ title: '网络错误，请重试', icon: 'none' });
    }
  },

  // 页面加载时验证管理员权限并获取免费模式状态
  async onLoad() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'amIAdmin' }
      });

      if (!res.result.isAdmin) {
        wx.showToast({ title: '无管理员权限', icon: 'none' });
        setTimeout(() => {
          wx.navigateBack();
        }, 1500);
        return;
      }

      // 获取当前免费模式状态
      this.fetchFreeModeStatus();
      // 获取商户配置列表
      this.fetchMerchantConfigs();
    } catch (err) {
      console.error('管理员权限验证失败：', err);
      wx.showToast({ title: '验证失败', icon: 'none' });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    }
  },

  // 获取当前免费模式状态
  async fetchFreeModeStatus() {
    try {
      const result = await wx.cloud.callFunction({
        name: 'device',
        data: { action: 'getDevices' }
      });
      if (result.result.success && result.result.data.length > 0) {
        // 检查第一个设备的免费状态
        const isFree = result.result.data[0].isFree || false;
        this.setData({ isFreeMode: isFree });
      }
    } catch (err) {
      console.error('获取免费模式状态失败:', err);
    }
  },

  // 切换免费模式
  async toggleFreeMode() {
    const newState = !this.data.isFreeMode;
    const actionText = newState ? '开启' : '关闭';

    wx.showModal({
      title: `确认${actionText}免费模式`,
      content: newState
        ? '确定要将所有储物柜设置为免费使用吗？用户将无需支付押金即可使用。'
        : '确定要将所有储物柜恢复为收费模式吗？',
      success: async (res) => {
        if (res.confirm) {
          this.showLoading('设置中...');
          try {
            const result = await wx.cloud.callFunction({
              name: 'adminops',
              data: { isFree: newState }
            });
            this.hideLoading();
            if (result.result.stats && result.result.stats.updated >= 0) {
              this.setData({ isFreeMode: newState });
              wx.showToast({
                title: `已${actionText}免费模式`,
                icon: 'success'
              });
            } else {
              wx.showToast({ title: '设置失败', icon: 'none' });
            }
          } catch (err) {
            this.hideLoading();
            console.error('设置免费模式失败:', err);
            wx.showToast({ title: '网络错误', icon: 'none' });
          }
        }
      }
    });
  },

  goUserOrders() {
    const userPhone = this.data.userPhone;
    if (!userPhone) {
      wx.showToast({ title: '请输入手机号', icon: 'none' });
      return;
    }
  
    wx.navigateTo({
      url: `/pages/admin/userorder?userPhone=${userPhone}`
    });
  },

  goDevOrders() {
    const internalNo = this.data.internalNo_ord;
    const lockerNo = this.data.lockerNo_ord;
    if (!internalNo || !lockerNo) {
      wx.showToast({ title: '请输入柜门编号和柜号', icon: 'none' });
      return;
    }
  
    wx.navigateTo({
      url: `/pages/admin/devorder?internalNo=${internalNo}&lockerNo=${lockerNo}`
    });
  },

  goMyDeviceList() { wx.navigateTo({ url: '/pages/admin/mydevice' }); },

  // 一键清空所有柜门
  async clearAllLockers() {
    wx.showModal({
      title: '确认清空所有柜门',
      content: '确定要清空所有设备上的占用柜门吗？这将强制结束所有进行中的订单，请谨慎操作！',
      success: async (res) => {
        if (res.confirm) {
          this.showLoading('正在清柜...');
          try {
            const result = await wx.cloud.callFunction({
              name: 'admin',
              data: { action: 'clearAllLockers' }
            });
            this.hideLoading();
            if (result.result.success) {
              wx.showToast({
                title: result.result.message || '清柜成功',
                icon: 'success'
              });
            } else {
              wx.showToast({
                title: result.result.errMsg || '清柜失败',
                icon: 'none'
              });
            }
          } catch (err) {
            this.hideLoading();
            console.error('清柜失败:', err);
            wx.showToast({ title: '清柜失败', icon: 'none' });
          }
        }
      }
    });
  },

  // 获取商户配置列表
  async fetchMerchantConfigs() {
    try {
      const result = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'getMerchantConfigs' }
      });
      if (result.result.success && result.result.data) {
        this.setData({ merchantList: result.result.data });
      }
    } catch (err) {
      console.error('获取商户配置失败:', err);
    }
  },

  // 切换商户
  async switchMerchant(e) {
    const merchantId = e.currentTarget.dataset.id;
    const currentMerchant = this.data.merchantList.find(m => m._id === merchantId);

    // 如果点击的是当前激活的商户，不处理
    if (currentMerchant && currentMerchant.isActive) {
      return;
    }

    const merchantName = currentMerchant ? currentMerchant.name : '该商户';
    wx.showModal({
      title: '确认切换商户',
      content: `确定要切换到「${merchantName}」吗？新订单将使用该商户支付。`,
      success: async (res) => {
        if (res.confirm) {
          this.showLoading('切换中...');
          try {
            const result = await wx.cloud.callFunction({
              name: 'admin',
              data: {
                action: 'switchMerchant',
                merchantId: merchantId
              }
            });
            this.hideLoading();
            if (result.result.success) {
              wx.showToast({
                title: result.result.message || '切换成功',
                icon: 'success'
              });
              // 刷新商户列表
              this.fetchMerchantConfigs();
            } else {
              wx.showToast({
                title: result.result.errMsg || '切换失败',
                icon: 'none'
              });
            }
          } catch (err) {
            this.hideLoading();
            console.error('切换商户失败:', err);
            wx.showToast({ title: '切换失败', icon: 'none' });
          }
        }
      }
    });
  }

})
