// pages/admin/mydevice.js
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
    lockerNo: '',
    showStatusModal: false,
    statusLockerNo: '',
    // 小程序列表
    miniPrograms: [],
    appidOptions: [],
    appidValues: [],
    // 修改归属弹窗
    showAppidModal: false,
    currentChangeDeviceId: null,
    currentChangeDeviceName: '',
    // 免费模式弹窗
    showFreeModal: false,
    currentFreeDeviceId: null,
    currentFreeDeviceName: '',
    currentFreeStatus: false,
  },

  onLoad() {
    this.getMiniPrograms();
    this.getDevices();
  },

  // 获取小程序列表
  async getMiniPrograms() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'getMiniPrograms' }
      });
      if (res.result.success && res.result.data) {
        this.setData({
          miniPrograms: res.result.data,
          appidOptions: res.result.data.map(p => p.miniName || p.name),
          appidValues: res.result.data.map(p => p.appid)
        });
      }
    } catch (err) {
      console.error('获取小程序列表失败:', err);
    }
  },

  async getDevices() {
    try {
      this.setData({ loading: true });

      // 使用 admin.getDevices 获取带归属信息的设备列表
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'getDevices' }
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

      const deviceIds = devices.map(d => d.deviceId);

      // 查询所有设备的订单统计（包括已切换归属的设备，历史订单仍在当前环境）
      if (deviceIds.length > 0) {
        const statRes = await wx.cloud.callFunction({
          name: 'order',
          data: {
            action: 'getDeviceOrderStats',
            deviceIds,
          },
        });

        if (statRes.result.success) {
          const statsMap = statRes.result.data;
          // 合并统计数据（所有设备都合并，已切换归属的设备历史订单仍在当前环境）
          devices = devices.map(d => ({
            ...d,
            ...(statsMap[d.deviceId] || {})
          }));
        }
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

  // === 复制设备链接 ===
  copyUrlLink(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => {
        wx.showToast({ title: '链接已复制', icon: 'success' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'none' });
      }
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

  confirmOpenAllLockers(e) {
    const internalNo = e.currentTarget.dataset.internalno;
    const cabinetCount = e.currentTarget.dataset.cabinetcount;
    const doorCount = e.currentTarget.dataset.doorcount;
  
    const totalDoors = cabinetCount * doorCount;
    
    wx.showModal({
      title: '确认全开',
      content: `确定打开本设备的所有 ${totalDoors} 个柜门？`,
      success: async res => {
        if (res.confirm) {
          // 初始化统计
          let successCount = 0;
          let failCount = 0;
          const failList = [];
  
          try {
            // 1. 仅生成柜号列表（此时不发送请求）
            const lockerNos = [];
            for (let i = 1; i <= totalDoors; i++) {
              lockerNos.push(i);
            }
  
            // 2. 真正控制并发（一次执行3个）
            const batchSize = 3;
            for (let i = 0; i < lockerNos.length; i += batchSize) {
              // 获取当前批次的柜号
              const batchNos = lockerNos.slice(i, i + batchSize);
              
              // 更新 UI 进度提示
              wx.showLoading({
                title: `正在打开 ${i + 1}-${Math.min(i + batchSize, totalDoors)}/${totalDoors}`,
                mask: true
              });
  
              // 3. 在这里才真正发起请求，并处理单个请求的异常
              const batchPromises = batchNos.map(lockerNo => {
                return wx.cloud.callFunction({
                  name: 'locker',
                  data: {
                    action: 'openDoorByAdmin',
                    internalNo,
                    lockerNo
                  }
                })
                .then(res => {
                  // 根据你的云函数返回结构判断是否成功，假设 result.success 为 true
                  if (res.result && res.result.success) {
                      successCount++;
                  } else {
                      failCount++;
                      failList.push(lockerNo);
                      console.error(`柜门 ${lockerNo} 业务逻辑失败:`, res);
                  }
                })
                .catch(err => {
                  console.error(`柜门 ${lockerNo} 网络/系统失败:`, err);
                  failCount++;
                  failList.push(lockerNo);
                  // 这里 catch 住错误，保证 Promise.all 不会崩
                  return null; 
                });
              });
  
              // 等待当前批次完成
              await Promise.all(batchPromises);
  
              // 4.增加 300ms 延时，防止瞬间请求过密导致硬件处理不过来
              if (i + batchSize < totalDoors) {
                  await new Promise(resolve => setTimeout(resolve, 300));
              }
            }
  
            wx.hideLoading();
  
            // 5. 最终结果汇总报告
            if (failCount === 0) {
              wx.showToast({ title: '全部打开成功', icon: 'success' });
            } else {
              wx.showModal({
                title: '执行完成',
                content: `成功: ${successCount} 个\n失败: ${failCount} 个\n失败柜号: ${failList.join(',')}`,
                showCancel: false,
                confirmText: '知道了'
              });
            }
  
          } catch (err) {
            wx.hideLoading();
            console.error('全开流程异常：', err);
            wx.showToast({ title: '流程执行异常', icon: 'none' });
          }
        }
      }
    });
  },

  // 1. 显示状态管理弹窗
  showStatusModal(e) {
    const internalNo = e.currentTarget.dataset.internalno;
    this.setData({
      showStatusModal: true,
      currentInternalNo: internalNo,
      statusLockerNo: '' // 清空输入框
    });
  },

  // 2. 关闭弹窗
  closeStatusModal() {
    this.setData({ showStatusModal: false });
  },

  // === 修改设备归属小程序 ===
  showAppidModal(e) {
    const deviceId = e.currentTarget.dataset.deviceid;
    const internalNo = e.currentTarget.dataset.internalno;
    this.setData({
      showAppidModal: true,
      currentChangeDeviceId: deviceId,
      currentChangeDeviceName: internalNo
    });
  },

  closeAppidModal() {
    this.setData({
      showAppidModal: false,
      currentChangeDeviceId: null,
      currentChangeDeviceName: ''
    });
  },

  // === 按设备设置免费模式 ===
  showFreeModeModal(e) {
    const deviceId = e.currentTarget.dataset.deviceid;
    const internalNo = e.currentTarget.dataset.internalno;
    // 从设备列表中查找当前设备的 isFree 状态，而不是依赖 dataset
    const device = this.data.devices.find(d => d.deviceId === deviceId);
    const isFreeStatus = device ? (device.isFree === true || device.isFree === 'true') : false;
    this.setData({
      showFreeModal: true,
      currentFreeDeviceId: deviceId,
      currentFreeDeviceName: internalNo,
      currentFreeStatus: isFreeStatus
    });
  },

  closeFreeModal() {
    this.setData({
      showFreeModal: false,
      currentFreeDeviceId: null,
      currentFreeDeviceName: '',
      currentFreeStatus: false
    });
  },

  // 切换免费模式
  async toggleDeviceFree() {
    const { currentFreeDeviceId, currentFreeDeviceName, currentFreeStatus } = this.data;
    // 关闭免费 -> isFree 设为 false，开启免费 -> isFree 设为 true
    const newFreeStatus = !currentFreeStatus;
    const actionText = newFreeStatus ? '开启' : '关闭';

    wx.showModal({
      title: '确认操作',
      content: `确定${actionText}设备 ${currentFreeDeviceName} 的免费模式吗？`,
      success: async res => {
        if (res.confirm) {
          wx.showLoading({ title: '设置中...' });
          try {
            const result = await wx.cloud.callFunction({
              name: 'admin',
              data: {
                action: 'setDeviceFree',
                deviceId: currentFreeDeviceId,
                isFree: newFreeStatus
              }
            });

            wx.hideLoading();
            if (result.result.success) {
              wx.showToast({ title: result.result.message || '设置成功', icon: 'success' });
              this.closeFreeModal();
              this.getDevices(); // 刷新设备列表
            } else {
              wx.showToast({ title: result.result.errMsg || '设置失败', icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            console.error('设置免费模式失败:', err);
            wx.showToast({ title: '设置失败', icon: 'none' });
          }
        }
      }
    });
  },

  // 选择小程序
  onAppidChange(e) {
    const index = e.detail.value;
    this.setData({
      selectedAppidIndex: index,
      selectedAppid: this.data.appidValues[index]
    });
  },

  // 确认修改归属
  async confirmChangeAppid() {
    const { currentChangeDeviceId, selectedAppid, appidOptions, selectedAppidIndex } = this.data;
    if (selectedAppidIndex === undefined) {
      wx.showToast({ title: '请选择小程序', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '切换中...' });
    try {
      // 使用 switchDeviceAppid 调用 locker_server 进行切换
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'switchDeviceAppid',
          deviceId: currentChangeDeviceId,
          targetAppid: selectedAppid
        }
      });

      wx.hideLoading();
      if (res.result.success) {
        wx.showToast({ title: '切换成功', icon: 'success' });
        this.closeAppidModal();
        this.getDevices(); // 刷新列表
      } else {
        wx.showToast({ title: res.result.errMsg || '切换失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('切换设备归属失败:', err);
      wx.showToast({ title: '切换失败', icon: 'none' });
    }
  },

  // 3. 监听柜号输入
  onStatusLockerInput(e) {
    this.setData({ statusLockerNo: e.detail.value });
  },

  // 4. 执行状态修改核心逻辑
  async updateLockerStatus(e) {
    const targetStatus = e.currentTarget.dataset.status; // 获取点击的是哪个按钮 (free/occupied/broken)
    const { currentInternalNo, statusLockerNo } = this.data;

    if (!statusLockerNo) {
      wx.showToast({ title: '请输入柜号', icon: 'none' });
      return;
    }

    // 定义提示颜色和文案
    let actionText = '';
    let confirmColor = '#576b95';
    switch (targetStatus) {
      case 'free': 
        actionText = '设为空闲'; 
        confirmColor = '#07c160'; 
        break;
      case 'occupied': 
        actionText = '设为占用'; 
        confirmColor = '#ffc300'; 
        break;
      case 'broken': 
        actionText = '设为故障'; 
        confirmColor = '#ff4d4f'; 
        break;
    }

    wx.showModal({
      title: '操作确认',
      content: `确定将设备 ${currentInternalNo} 的 ${statusLockerNo} 号柜 ${actionText} 吗？`,
      confirmColor: confirmColor,
      success: async res => {
        if (res.confirm) {
          wx.showLoading({ title: '设置中...' });

          try {
            // 调用云函数 locker -> setLockerStatus
            const result = await wx.cloud.callFunction({
              name: 'locker',
              data: {
                action: 'setLockerStatus',
                internalNo: currentInternalNo,
                lockerNo: parseInt(statusLockerNo),
                status: targetStatus
              }
            });

            wx.hideLoading();

            if (result.result.success) {
              wx.showToast({ title: '设置成功', icon: 'success' });
              this.closeStatusModal(); // 成功后关闭弹窗
            } else {
              wx.showModal({
                title: '设置失败',
                content: result.result.errMsg || '未知错误',
                showCancel: false
              });
            }
          } catch (err) {
            wx.hideLoading();
            console.error('设置状态异常', err);
            wx.showToast({ title: '网络异常', icon: 'none' });
          }
        }
      }
    });
  },

});