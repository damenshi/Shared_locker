Page({
  data: {
    loading: true,
    merchantList: [],
    // 可用商户数（非限制状态）
    availableCount: 0,
    // 全局限额（达到后自动切换，0 表示不限）
    limits: { dailyOrderLimit: 0, complaintRateLimit: 0 },
    orderLimitInput: '0',
    rateLimitInput: '0'
  },

  onLoad() {
    this.checkPermission();
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
        return;
      }
      this.fetchMerchants();
    } catch (err) {
      console.error('权限检查失败：', err);
      wx.navigateBack();
    }
  },

  async fetchMerchants() {
    try {
      this.setData({ loading: true });
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'getMerchantConfigs' }
      });
      if (res.result && res.result.success && res.result.data) {
        const limits = res.result.limits || { dailyOrderLimit: 0, complaintRateLimit: 0 };
        const list = res.result.data.map(m => {
          const todayOrders = m.todayOrders || 0;
          const todayComplaints = m.todayComplaints || 0;
          const totalOrders = m.totalOrders || 0;
          const totalComplaints = m.totalComplaints || 0;
          const todayRate = todayOrders > 0
            ? (100 * todayComplaints / todayOrders).toFixed(2)
            : (todayComplaints > 0 ? '100.00' : '0.00');
          return {
            ...m,
            status: m.status || 'normal',
            isRestricted: (m.status || 'normal') === 'restricted',
            todayOrders,
            todayComplaints,
            totalOrders,
            totalComplaints,
            consecutivePayFails: m.consecutivePayFails || 0,
            // 默认参与自动轮换（字段缺失视为 true）
            autoRotate: m.autoRotate !== false,
            todayRate,
            totalRate: totalOrders > 0
              ? (100 * totalComplaints / totalOrders).toFixed(2)
              : '0.00',
            // 今日投诉率是否已达阈值（用于红色高亮，阈值为全局限额）
            todayRateDanger: (limits.complaintRateLimit > 0) && Number(todayRate) >= limits.complaintRateLimit
          };
        });
        // 排序：使用中 > 正常 > 限制，同组内按 order 权重升序
        list.sort((a, b) => {
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          if (a.isRestricted !== b.isRestricted) return a.isRestricted ? 1 : -1;
          return (a.order || 99) - (b.order || 99);
        });
        this.setData({
          merchantList: list,
          availableCount: list.filter(m => !m.isRestricted).length,
          limits,
          orderLimitInput: String(limits.dailyOrderLimit || 0),
          rateLimitInput: String(limits.complaintRateLimit || 0),
          loading: false
        });
      } else {
        this.setData({ loading: false });
        wx.showToast({ title: (res.result && res.result.errMsg) || '加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('获取商户列表失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 切换使用（restricted 商户在 wxml 中已禁用按钮）
  async switchMerchant(e) {
    const { id, name } = e.currentTarget.dataset;
    const confirm = await wx.showModal({
      title: '切换商户',
      content: `确定切换到「${name}」吗？切换后新订单将使用该商户收款。`,
      confirmText: '确定切换'
    });
    if (!confirm.confirm) return;

    wx.showLoading({ title: '切换中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'switchMerchant', merchantId: id }
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        wx.showToast({ title: '已切换', icon: 'success' });
        this.fetchMerchants();
      } else {
        wx.showToast({ title: (res.result && res.result.errMsg) || '切换失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('切换商户失败:', err);
      wx.showToast({ title: '切换失败', icon: 'none' });
    }
  },

  // 标记限制 / 恢复正常
  async toggleStatus(e) {
    const { id, name, status } = e.currentTarget.dataset;
    const toRestricted = status !== 'restricted';
    const confirm = await wx.showModal({
      title: toRestricted ? '标记限制' : '恢复正常',
      content: toRestricted
        ? `确定将「${name}」标记为限制状态吗？若该商户正在使用中，将自动切换到下一个可用商户。`
        : `确定将「${name}」恢复为正常状态吗？恢复后可以被切换使用。`,
      confirmText: '确定'
    });
    if (!confirm.confirm) return;

    wx.showLoading({ title: '处理中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'updateMerchantStatus',
          merchantId: id,
          status: toRestricted ? 'restricted' : 'normal'
        }
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        const autoSwitch = res.result.autoSwitch;
        if (toRestricted && autoSwitch && autoSwitch.switched) {
          wx.showToast({ title: `已限制并切换到${autoSwitch.name}`, icon: 'none' });
        } else if (toRestricted && autoSwitch && !autoSwitch.switched) {
          wx.showModal({ title: '已标记限制', content: '但没有其他可用商户可切换，请尽快处理！', showCancel: false });
        } else {
          wx.showToast({ title: res.result.message || '已完成', icon: 'success' });
        }
        this.fetchMerchants();
      } else {
        wx.showToast({ title: (res.result && res.result.errMsg) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('修改商户状态失败:', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onOrderLimitInput(e) {
    this.setData({ orderLimitInput: e.detail.value });
  },

  // 设置是否参与自动轮换
  async onAutoRotateChange(e) {
    const { id } = e.currentTarget.dataset;
    const autoRotate = e.detail.value;
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'updateMerchantAutoRotate', merchantId: id, autoRotate }
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message || '已设置', icon: 'none' });
      } else {
        wx.showToast({ title: (res.result && res.result.errMsg) || '设置失败', icon: 'none' });
      }
    } catch (err) {
      console.error('设置自动轮换失败:', err);
      wx.showToast({ title: '设置失败', icon: 'none' });
    }
    this.fetchMerchants();
  },

  onRateLimitInput(e) {
    this.setData({ rateLimitInput: e.detail.value });
  },

  async saveLimits() {
    const orderLimit = Number(this.data.orderLimitInput);
    const rateLimit = Number(this.data.rateLimitInput);
    if (isNaN(orderLimit) || orderLimit < 0 || !Number.isInteger(orderLimit)) {
      wx.showToast({ title: '订单限额须为不小于0的整数', icon: 'none' });
      return;
    }
    if (isNaN(rateLimit) || rateLimit < 0 || rateLimit > 100) {
      wx.showToast({ title: '投诉率阈值须在0~100之间', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'updateMerchantLimits',
          dailyOrderLimit: orderLimit,
          complaintRateLimit: rateLimit
        }
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        wx.showToast({ title: '已保存', icon: 'success' });
        this.fetchMerchants();
      } else {
        wx.showToast({ title: (res.result && res.result.errMsg) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('保存限额失败:', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  }
});
