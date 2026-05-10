// pages/mine/complaintList.js
const app = getApp();

function formatDate(dateStr) {
  if (!dateStr) return '无';
  const date = new Date(dateStr);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

Page({
  data: {
    complaints: [],
    loading: true,
    openid: ''
  },

  onLoad() {
    this.setData({
      openid: app.globalData.openid || ''
    });
  },

  onShow() {
    this.getComplaints();
  },

  async getComplaints() {
    if (!this.data.openid) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      this.setData({ loading: false });
      return;
    }

    try {
      this.setData({ loading: true });
      const res = await wx.cloud.callFunction({
        name: 'complaint',
        data: { action: 'getMyComplaints' }
      });

      if (res.result.success) {
        const complaints = (res.result.data || []).map(item => {
          return {
            ...item,
            createdAtFormatted: formatDate(item.createdAt)
          };
        });
        this.setData({ complaints, loading: false });
      } else {
        wx.showToast({ title: res.result.errMsg || '获取失败', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error('获取投诉列表失败：', err);
      wx.showToast({ title: '系统错误，请重试', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  goComplaintForm() {
    wx.navigateTo({ url: '/pages/mine/complaintForm' });
  },

  goComplaintDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/mine/complaintDetail?id=${id}` });
  },

  callService() {
    wx.makePhoneCall({ phoneNumber: '4008326132' });
  }
});
