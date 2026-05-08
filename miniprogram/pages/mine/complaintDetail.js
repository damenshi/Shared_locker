// pages/mine/complaintDetail.js
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
    complaint: {},
    loading: true
  },

  onLoad(options) {
    if (options.id) {
      this.fetchComplaintDetail(options.id);
    } else {
      wx.showToast({ title: '缺少投诉ID', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  async fetchComplaintDetail(complaintId) {
    try {
      this.setData({ loading: true });
      const res = await wx.cloud.callFunction({
        name: 'complaint',
        data: {
          action: 'getComplaintDetail',
          complaintId: complaintId
        }
      });

      if (res.result.success) {
        const complaint = res.result.data;
        complaint.createdAtFormatted = formatDate(complaint.createdAt);
        complaint.handledAtFormatted = formatDate(complaint.handledAt);
        this.setData({ complaint, loading: false });
      } else {
        wx.showToast({ title: res.result.errMsg || '获取失败', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error('获取投诉详情失败：', err);
      wx.showToast({ title: '系统错误', icon: 'none' });
      this.setData({ loading: false });
    }
  }
});
