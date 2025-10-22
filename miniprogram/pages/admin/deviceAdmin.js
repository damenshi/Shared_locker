// pages/admin/deviceAdmin.js
const app = getApp();

function formatDate(dateStr) {
  const date = new Date(dateStr); // "2025-09-26T16:58:53.136Z"
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

Page({
  data: {
    devices: [],
    loading: true,
    expandedDeviceId: null, 
    showOpenLocker: false,
    currentDeviceId: null,
    currentInternalNo: null,
    lockerNo: ''
  },

  onLoad(options) {
    const allowedInternalNo = options.allowed ? JSON.parse(decodeURIComponent(options.allowed)) : [];
    this.getDevices(allowedInternalNo);
  },

  async getDevices(allowedInternalNo) {
    try {
      this.setData({ loading: true });
  
      const res = await wx.cloud.callFunction({
        name: 'device',
        data: { action: 'getDevicesByInternalNo', internalNos: allowedInternalNo}
      });
  
      if (!res.result.success) {
        wx.showToast({ title: res.result.errMsg || '暂无设备', icon: 'none' });
        this.setData({ loading: false });
        return;
      }
  
      let devices = res.result.data || [];
  
      // 格式化时间
      devices = devices.map(device => ({
        ...device,
        createdAtFormatted: device.createdAt ? formatDate(device.createdAt) : '无',
        updatedAtFormatted: device.updatedAt ? formatDate(device.updatedAt) : '无',
        lastLoginFormatted: device.lastLoginTime ? formatDate(device.lastLoginTime) : '无',
        // 先默认订单数据为 0，后续加载
        todayPaid: 0,
        todayRefunded: 0,
        thisMonthPaid: 0,
        thisMonthRefunded: 0,
        lastMonthPaid: 0,
        lastMonthRefunded: 0,
      }));
  
      // 先展示基本信息
      // this.setData({ devices });
      
      const deviceIds = devices.map(d => d.deviceId);

      const statRes = await wx.cloud.callFunction({
        name: 'order',
        data: {
          action: 'getDeviceOrderStats',
          deviceIds,
        },
      });

      if (statRes.result.success) {
        const statsMap = statRes.result.data;
        // 合并统计数据
        devices = devices.map(d => ({
          ...d,
          ...(statsMap[d.deviceId] || {})
        }));
      }
      // 更新视图
      this.setData({
        devices,
        loading: false
      });
  
    } catch (err) {
      console.error('获取设备列表失败：', err);
      wx.showToast({ title: '获取设备列表失败，请重试', icon: 'none' });
      this.setData({ loading: false });
    }
  },
  
  /**
   * 获取单个设备的订单统计
   */
  async getDeviceOrderStats(deviceId) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: {
          action: 'getDeviceOrderStats',
          deviceId
        }
      });
  
      return res.result;
    } catch (err) {
      console.error(`获取设备 ${deviceId} 订单失败：`, err);
      return { success: false, errMsg: err.message };
    }
  },
  toggleDetail(e) {
    const id = e.currentTarget.dataset.deviceid;
    this.setData({
      expandedDeviceId: this.data.expandedDeviceId === id ? null : id
    });
  },

  // === 打开柜门 ===
  showOpenLockerModal(e) {
    this.setData({
      showOpenLocker: true,
      currentInternalNo: e.currentTarget.dataset.internalno
    });
  },

  closeModal() {
    this.setData({ showOpenLocker: false, lockerNo: '' });
  },

  onLockerNoInput(e) {
    this.setData({ lockerNo: e.detail.value });
  },

  confirmOpenLocker() {
    const { currentInternalNo, lockerNo } = this.data;
    if (!lockerNo) {
      wx.showToast({ title: '请输入柜号', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认开柜',
      content: `确定打开柜门 ${lockerNo} 吗？`,
      success: async res => {
        if (res.confirm) {
          wx.showLoading('正在开门...');
    
          try {
            const result = await wx.cloud.callFunction({
              name: 'locker',
              data: {
                action: 'openDoorByAdmin',
                internalNo: currentInternalNo,
                lockerNo: parseInt(lockerNo)
              }
            });
      
            wx.hideLoading();
            
            if (!result.result.success)
              throw new Error('开门失败，设备不在线');
            wx.showToast({ title: '柜门已打开', icon: 'success' });
            this.closeModal();

          } catch (err) {
            wx.hideLoading();
            console.error('开门失败：', err);
            wx.showToast({ title: '开门失败，设备不在线', icon: 'none' });
            this.closeModal();
          }
        }
      }
    });
  },

  // === 清柜 ===
  confirmClearLockers(e) {
    const deviceId = e.currentTarget.dataset.deviceid;
    wx.showModal({
      title: '确认清空',
      content: `确定清空本设备所有柜门状态？请谨慎操作`,
      success: async res => {
        if (res.confirm) {
          wx.showLoading('正在清柜...');

          try {
            const result = await wx.cloud.callFunction({
              name: 'locker',
              data: {
                action: 'freeDoorByDev',
                deviceId: deviceId,
              }
            });

            wx.hideLoading();
            
            if (!result.result.success)
              throw new Error('清柜失败，设备不在线');
            wx.showToast({ title: '清柜成功', icon: 'success' });

          }catch (err) {
            wx.hideLoading();
            console.error('清柜失败：', err);
            wx.showToast({ title: '清柜失败，设备不在线', icon: 'none' });
            this.closeModal();
          }
        }
      }
    });
  },

  // === 全开 ===
  confirmOpenAllLockers(e) {
    const internalNo = e.currentTarget.dataset.internalno;
    const cabinetCount = e.currentTarget.dataset.cabinetcount;
    const doorCount = e.currentTarget.dataset.doorcount;
    const totalDoors = cabinetCount * doorCount;

    wx.showModal({
      title: '确认全开',
      content: `确定打开本设备的所有${totalDoors} 个柜门？`,
      success: async res => {
        if (res.confirm) {
          wx.showLoading('正在打开所有柜门...');
    
          try {
             // 构建所有开门任务
          const openTasks = [];
          for (let lockerNo = 1; lockerNo <= totalDoors; lockerNo++) {
            openTasks.push(
              wx.cloud.callFunction({
                name: 'locker',
                data: {
                  action: 'openDoorByAdmin',
                  internalNo,
                  lockerNo
                }
              })
            );
          }

          // 控制并发（一次执行5个，避免云函数超时）
          const batchSize = 5;
          for (let i = 0; i < openTasks.length; i += batchSize) {
            const batch = openTasks.slice(i, i + batchSize);
            await Promise.all(batch);
          }

          wx.hideLoading();
          wx.showToast({ title: '所有柜门已打开', icon: 'success' });
            
          } catch (err) {
            wx.hideLoading();
            console.error('全开柜门失败：', err);
            wx.showToast({ title: '全开柜门失败', icon: 'none' });
            this.closeModal();
          }
        }
      }
    });
  }
});