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
    currentFilter: 'pending',
    stats: {
      total: 0,
      pending: 0,
      resolved: 0
    },
    subscribeTemplateId: ''
  },

  onLoad() {
    this.checkPermission();
  },

  async onShow() {
    // 先确保模板ID已获取，再拉取投诉列表
    if (!this.data.subscribeTemplateId) {
      await this.fetchSubscribeTemplateId();
    }
    await this.fetchComplaints();
  },

  // 页面加载时提前获取模板ID
  async fetchSubscribeTemplateId() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'complaint',
        data: { action: 'getSubscribeConfig' }
      })
      const templateId = res.result?.data?.templateId || ''
      this.setData({ subscribeTemplateId: templateId })
    } catch (err) {
      console.warn('[订阅] 获取模板ID失败:', err)
    }
  },

  // 有待处理投诉且有新通知时弹出订阅提示（每次订阅仅接收一条通知）
  async _promptSubscribeIfNeeded(stats) {
    if (stats.pending <= 0 || !this.data.subscribeTemplateId) return;

    try {
      // 获取管理员最近一次收到通知的时间
      const statusRes = await wx.cloud.callFunction({
        name: 'complaint',
        data: { action: 'getAdminNotifyStatus' }
      });
      const lastNotifiedAt = statusRes.result?.data?.lastNotifiedAt;

      // 获取本地记录的上次弹窗时间
      const lastPromptTime = wx.getStorageSync('lastPromptTime');

      // 如果没有收到过通知，或上次弹窗在最近通知之后，则不弹
      if (!lastNotifiedAt) return;
      if (lastPromptTime && new Date(lastPromptTime) >= new Date(lastNotifiedAt)) return;

      this._promptSubscribe();
    } catch (err) {
      console.warn('[订阅] 获取通知状态失败:', err);
    }
  },

  _promptSubscribe() {

    wx.showModal({
      title: '订阅投诉通知',
      content: '有新投诉待处理，是否订阅通知？（每次订阅仅接收一条通知）',
      confirmText: '立即订阅',
      cancelText: '暂不',
      success: (res) => {
        if (res.confirm) {
          this.subscribeNotify();
        } else {
          // 用户点了"暂不"，也记录时间，避免反复弹窗
          wx.setStorageSync('lastPromptTime', new Date().toISOString());
        }
      }
    });
  },

  // 管理员点击订阅投诉通知（必须同步调用，不能有await）
  subscribeNotify() {
    const templateId = this.data.subscribeTemplateId
    if (!templateId) {
      wx.showToast({ title: '未配置通知模板', icon: 'none' })
      return
    }

    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success(subRes) {
        console.log('[订阅] 授权结果:', subRes);
        if (subRes[templateId] === 'accept') {
          wx.showToast({ title: '订阅成功', icon: 'success' })
          // 记录本次弹窗时间，避免重复弹窗
          wx.setStorageSync('lastPromptTime', new Date().toISOString())
        }
      },
      fail(err) {
        console.warn('[订阅] 授权失败:', err);
        wx.showToast({ title: '订阅失败', icon: 'none' })
      }
    });
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
          action: 'getComplaintList'
        }
      });

      if (res.result.success) {
        const allComplaints = (res.result.data || []).map(item => {
          return {
            ...item,
            createdAtFormatted: formatDate(item.createdAt)
          };
        });

        const stats = {
          total: allComplaints.length,
          pending: allComplaints.filter(c => c.status === 'pending').length,
          resolved: allComplaints.filter(c => c.status === 'resolved').length
        };

        const complaints = this.data.currentFilter
          ? allComplaints.filter(c => c.status === this.data.currentFilter)
          : allComplaints;

        this.setData({ complaints, stats, loading: false });

        // 有待处理投诉且有新通知时提醒管理员订阅
        this._promptSubscribeIfNeeded(stats);
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
  },

  async deleteComplaint(e) {
    const id = e.currentTarget.dataset.id;
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
                complaintId: id
              }
            });

            wx.hideLoading();
            if (result.result.success) {
              wx.showToast({ title: '已删除', icon: 'success' });
              this.fetchComplaints();
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
  }
});
