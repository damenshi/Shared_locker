// pages/mine/complaintDetail.js
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${m}-${d} ${hh}:${mm}`;
}

Page({
  data: {
    complaint: {},
    messages: [],
    loading: true,
    userReplyText: ''
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

        // 构建消息数组
        const messages = [];

        // 用户初始投诉
        messages.push({
          sender: 'user',
          name: '我',
          content: complaint.content,
          time: formatDate(complaint.createdAt)
        });

        // 管理员回复
        if (complaint.reply) {
          messages.push({
            sender: 'admin',
            name: '客服',
            content: complaint.reply,
            time: formatDate(complaint.handledAt)
          });
        }

        // 用户追加回复
        if (complaint.userReply) {
          messages.push({
            sender: 'user',
            name: '我',
            content: complaint.userReply,
            time: formatDate(complaint.userReplyAt)
          });
        }

        this.setData({ complaint, messages, loading: false });
      } else {
        wx.showToast({ title: res.result.errMsg || '获取失败', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error('获取投诉详情失败：', err);
      wx.showToast({ title: '系统错误', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  onUserReplyInput(e) {
    this.setData({ userReplyText: e.detail.value });
  },

  async submitUserReply() {
    const reply = this.data.userReplyText.trim();
    if (!reply) {
      wx.showToast({ title: '请输入回复内容', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...', mask: true });
    try {
      const result = await wx.cloud.callFunction({
        name: 'complaint',
        data: {
          action: 'addUserReply',
          complaintId: this.data.complaint._id,
          reply: reply
        }
      });

      wx.hideLoading();
      if (result.result.success) {
        wx.showToast({ title: '回复已提交', icon: 'success' });
        this.setData({ userReplyText: '' });
        this.fetchComplaintDetail(this.data.complaint._id);
      } else {
        wx.showToast({ title: result.result.errMsg || '提交失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('提交用户回复失败：', err);
      wx.showToast({ title: '系统错误', icon: 'none' });
    }
  }
});
