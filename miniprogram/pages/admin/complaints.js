// pages/admin/complaints.js
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
    currentFilter: '',
    stats: {
      total: 0,
      pending: 0,
      processing: 0,
      resolved: 0,
      rejected: 0
    }
  },

  onLoad() {
    this.checkPermission();
  },

  onShow() {
    this.fetchComplaints();
  },

  async checkPermission() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'amIAdmin' }
      });
      if (!res.result.isAdmin || res.result.role !== 'super') {
        wx.showToast({ title: '无权限访问', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1500);
      }
    } catch (err) {
      console.error('权限检查失败：', err);
      wx.navigateBack();
    }
  },

  async fetchComplaints() {
    try {
      this.setData({ loading: true });
      const res = await wx.cloud.callFunction({
        name: 'complaint',
        data: {
          action: 'getComplaintList',
          status: this.data.currentFilter || undefined
        }
      });

      if (res.result.success) {
        const complaints = (res.result.data || []).map(item => {
          return {
            ...item,
            createdAtFormatted: formatDate(item.createdAt)
          };
        });

        const stats = {
          total: complaints.length,
          pending: complaints.filter(c => c.status === 'pending').length,
          processing: complaints.filter(c => c.status === 'processing').length,
          resolved: complaints.filter(c => c.status === 'resolved').length,
          rejected: complaints.filter(c => c.status === 'rejected').length
        };

        this.setData({ complaints, stats, loading: false });
      } else {
        wx.showToast({ title: res.result.errMsg || '获取失败', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error('获取投诉列表失败：', err);
      wx.showToast({ title: '系统错误', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  filterByStatus(e) {
    const status = e.currentTarget.dataset.status;
    this.setData({ currentFilter: status });
    this.fetchComplaints();
  },

  handleComplaint(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/admin/complaintDetail?id=${id}`
    });
  },

  viewDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/admin/complaintDetail?id=${id}`
    });
  }
});
