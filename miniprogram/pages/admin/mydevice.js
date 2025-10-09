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
  },

  onLoad() {
    // this.setData({
    //   openid: app.globalData.openid || ''
    // });
    this.getDevices();
  },

  /**
   * 获取订单列表
   */
  async getDevices() {
    // if (!this.data.openid) {
    //   wx.showToast({ title: '请先登录', icon: 'none' });
    //   return;
    // }

    try {
      this.setData({ loading: true });
      const res = await wx.cloud.callFunction({
        name: 'device',
        data: {
          action: 'getDevices',
        }
      });
      console.log("res.result.data:", res.result.data);
      if (res.result.success) {
        const devices = (res.result.data || []).map(device => {
          if (device.createdAt) {
            device.createdAtFormatted = formatDate(device.createdAt);
            device.updatedAtFormatted = formatDate(device.updatedAt);
            device.lastLoginFormatted = formatDate(device.lastLoginTime);
          } else {
            device.createdAtFormatted = '无';
            device.updatedAtFormatted = '无';
            device.lastLoginFormatted = '无';
          }
          return device;
        });
        this.setData({
          devices,
          loading: false
        });
      } else {
        wx.showToast({ title: res.result.errMsg || '暂无设备', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error('获取设备列表失败：', err);
      wx.showToast({ title: '获取设备列表失败：，请重试', icon: 'none' });
      this.setData({ loading: false });
    }
  },
});