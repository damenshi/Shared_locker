Page({
  data: {
    // 订单管理相关
    orderId: '',
    
    // 柜门控制相关
    lockerId: '',
    
    // 批量生成设备相关
    deviceCount: 1, 
  
    // 批量生成储物柜相关
    selectedDeviceId: null, // 选择要生成锁的设备
    cabinetCount: 2, //每个设备的锁板数量
    lockersPerCabinet: 5, // 每个锁板的锁数量
    
    // 生成二维码相关
    // selectedDeviceId: null,
    // qrcodeList: [],
    
    // 加载状态
    loading: false
  },

  // 输入框变化处理
  onInputChange(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [field]: e.detail.value });
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

  // 1. 强制结束订单
  async forceFinishOrder() {
    const { orderId } = this.data;
    
    if (!orderId) {
      return wx.showToast({ title: '请输入订单ID', icon: 'none' });
    }

    this.showLoading('正在强制结束订单...');
    
    try {
      const result = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'forceFinish',
          orderId: orderId
        }
      });

      this.hideLoading();
      
      if (result.result.success) {
        wx.showToast({ title: '订单已强制结束', icon: 'success' });
      } else {
        wx.showToast({ title: result.result.errMsg || '操作失败', icon: 'none' });
      }
    } catch (err) {
      this.hideLoading();
      console.error('强制结束订单失败：', err);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  },

  // 2. 订单退款
  async refundOrder() {
    const { orderId } = this.data;
    
    if (!orderId) {
      return wx.showToast({ title: '请输入订单ID', icon: 'none' });
    }

    this.showLoading('正在处理退款...');
    
    try {
      const result = await wx.cloud.callFunction({
        name: 'main',
        data: {
          action: 'refund',
          id: orderId
        }
      });

      this.hideLoading();
      
      if (result.result.ok) {
        wx.showToast({ title: '退款成功', icon: 'success' });
      } else {
        wx.showToast({ title: result.result.errMsg || '退款失败', icon: 'none' });
      }
    } catch (err) {
      this.hideLoading();
      console.error('退款失败：', err);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  },

  // 3. 远程打开柜门
  async openAnyDoor() {
    const { lockerId } = this.data;
    
    if (!lockerId) {
      return wx.showToast({ title: '请输入柜子ID', icon: 'none' });
    }

    this.showLoading('正在开门...');
    
    try {
      const result = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'openDoor',
          lockerId: lockerId
        }
      });

      this.hideLoading();
      
      if (result.result.success) {
        wx.showToast({ title: '柜门已打开', icon: 'success' });
      } else {
        wx.showToast({ title: result.result.errMsg || '开门失败', icon: 'none' });
      }
    } catch (err) {
      this.hideLoading();
      console.error('开门失败：', err);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  },

  //批量生成设备
  async batchCreateDevices() {
    const { deviceCount } = this.data;
    
    if (deviceCount <= 0) {
      return wx.showToast({ 
        title: '请输入有效的设备数量（需大于0）', 
        icon: 'none' 
      });
    }

    this.showLoading('生成设备中...');
    
    try {
      const result = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'batchCreateDevices',
          deviceCount: parseInt(deviceCount)
        }
      });

      this.hideLoading();
      
      if (result.result.success) {
        wx.showToast({
          title: `成功生成 ${result.result.count} 个设备`,
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
      console.error('批量生成设备失败：', err);
      wx.showToast({ title: '网络错误，请重试', icon: 'none' });
    }
  },
  
  //基于设备生成锁
  async batchCreateLockersByDevice() {
    const { selectedDeviceId, cabinetCount, lockersPerCabinet } = this.data;
    
    if (!selectedDeviceId || cabinetCount <= 0 || lockersPerCabinet <= 0) {
      return wx.showToast({ 
        title: '请选择设备并输入有效的锁板/锁数量', 
        icon: 'none' 
      });
    }

    this.showLoading('生成锁具中...');
    
    try {
      const result = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'batchCreateLockers',
          deviceId: selectedDeviceId, // 指定设备ID
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


  // 5. 生成储物柜二维码
  // async generateLockerQrcodes() {
  //   const { selectedDeviceId } = this.data;

  //   this.showLoading('生成二维码中...');
    
  //   try {
  //     const result = await wx.cloud.callFunction({
  //       name: 'admin',
  //       data: {
  //         action: 'generateLockerQrcodes',
  //         deviceId: selectedDeviceId ? parseInt(selectedDeviceId) : null
  //       }
  //     });

  //     this.hideLoading();
      
  //     if (result.result.success) {
  //       wx.showToast({
  //         title: `成功生成 ${result.result.count} 个二维码`,
  //         icon: 'success',
  //         duration: 2000
  //       });
  //       // 显示生成的二维码列表
  //       this.setData({ qrcodeList: result.result.data });
  //     } else {
  //       wx.showToast({
  //         title: result.result.errMsg || '生成失败',
  //         icon: 'none'
  //       });
  //     }
  //   } catch (err) {
  //     this.hideLoading();
  //     console.error('生成二维码函数失败：', err);
  //     wx.showToast({ title: '网络错误，请重试', icon: 'none' });
  //   }
  // },

  // 页面加载时验证管理员权限
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
      }
    } catch (err) {
      console.error('管理员权限验证失败：', err);
      wx.showToast({ title: '验证失败', icon: 'none' });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    }
  }
})
