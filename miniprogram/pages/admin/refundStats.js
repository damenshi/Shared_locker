// pages/admin/refundStats.js

Page({
  data: {
    loading: true,
    summary: null,
    devices: [],
    deviceMap: {}
  },

  onLoad() {
    this.fetchStats();
  },

  async fetchStats() {
    try {
      this.setData({ loading: true });

      // 先获取设备列表（用于显示设备名称）
      const devRes = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'getDevices' }
      });

      const deviceMap = {};
      if (devRes.result && devRes.result.data) {
        for (const d of devRes.result.data) {
          deviceMap[d.deviceId] = d;
        }
      }

      // 获取退款率统计
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getRefundStats' }
      });

      if (res.result.success) {
        const { summary, devices: deviceStats } = res.result.data;

        // 将设备统计转为数组，附加设备信息
        const devices = Object.keys(deviceStats).map(deviceId => {
          const stats = deviceStats[deviceId];
          const info = deviceMap[deviceId] || {};
          return {
            deviceId,
            internalNo: info.internalNo || deviceId,
            deviceAddress: info.deviceAddress || '',
            ...stats
          };
        }).sort((a, b) => (a.internalNo || '').localeCompare(b.internalNo || ''));

        this.setData({ summary, devices, deviceMap, loading: false });
      } else {
        wx.showToast({ title: res.result.errMsg || '获取失败', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error('获取退款率统计失败：', err);
      wx.showToast({ title: '系统错误', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  // 退款率颜色类
  getRateColor(rate) {
    if (rate === 0 || rate === undefined) return 'rate-green';
    if (rate < 10) return 'rate-green';
    if (rate < 30) return 'rate-orange';
    return 'rate-red';
  },

  onPullDownRefresh() {
    this.fetchStats().then(() => wx.stopPullDownRefresh());
  }
});
