// pages/admin/complaintDetail.js
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
    replyText: '',
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

        // 构建消息数组
        const messages = [];

        // 用户初始投诉
        messages.push({
          sender: 'user',
          name: complaint.phone || '用户',
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
            name: complaint.phone || '用户',
            content: complaint.userReply,
            time: formatDate(complaint.userReplyAt)
          });
        }

        this.setData({
          complaint,
          messages,
          replyText: complaint.reply || '',
          loading: false
        });
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

  onReplyInput(e) {
    this.setData({ replyText: e.detail.value });
  },

  async updateStatus(e) {
    const status = e.currentTarget.dataset.status;
    const statusText = {
      resolved: '已解决'
    }[status];

    wx.showModal({
      title: '确认操作',
      content: `确定要将此投诉标记为"${statusText}"吗？`,
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          try {
            const result = await wx.cloud.callFunction({
              name: 'complaint',
              data: {
                action: 'updateStatus',
                complaintId: this.data.complaint._id,
                status: status
              }
            });

            wx.hideLoading();
            if (result.result.success) {
              wx.showToast({ title: '状态已更新', icon: 'success' });
              this.fetchComplaintDetail(this.data.complaint._id);
            } else {
              wx.showToast({ title: result.result.errMsg || '更新失败', icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            wx.showToast({ title: '系统错误', icon: 'none' });
          }
        }
      }
    });
  },

  viewUserOrders() {
    const phone = this.data.complaint.phone;
    if (!phone) {
      wx.showToast({ title: '用户未提供手机号', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/admin/userorder?userPhone=${phone}`
    });
  },

  async deleteComplaint() {
    wx.showModal({
      title: '确认删除',
      content: '确定要删除此投诉吗？删除后不可恢复。',
      confirmColor: '#e74c3c',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...' });
          try {
            const result = await wx.cloud.callFunction({
              name: 'complaint',
              data: {
                action: 'deleteComplaint',
                complaintId: this.data.complaint._id
              }
            });

            wx.hideLoading();
            if (result.result.success) {
              wx.showToast({ title: '已删除', icon: 'success' });
              setTimeout(() => {
                wx.navigateBack();
              }, 1500);
            } else {
              wx.showToast({ title: result.result.errMsg || '删除失败', icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            wx.showToast({ title: '系统错误', icon: 'none' });
          }
        }
      }
    });
  },

  async submitReply() {
    const reply = this.data.replyText.trim();
    if (!reply) {
      wx.showToast({ title: '请输入回复内容', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...' });
    try {
      const result = await wx.cloud.callFunction({
        name: 'complaint',
        data: {
          action: 'addReply',
          complaintId: this.data.complaint._id,
          reply: reply
        }
      });

      wx.hideLoading();
      if (result.result.success) {
        wx.showToast({ title: '回复已提交', icon: 'success' });
        this.fetchComplaintDetail(this.data.complaint._id);
      } else {
        wx.showToast({ title: result.result.errMsg || '提交失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '系统错误', icon: 'none' });
    }
  }
});
