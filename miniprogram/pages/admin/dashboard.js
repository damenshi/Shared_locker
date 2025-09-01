// miniprogram/pages/admin/dashboard.js
Page({
  data: {
    stat: {
      todayIncome: 0,
      todayOrders: 0,
      todayARPU: 0,
      monthIncome: 0,
      monthOrders: 0,
      monthARPU: 0
    },
    display: {
      today: '',
      month: ''
    }
  },

  onLoad() {
    this.loadStat();
  },

  async loadStat() {
    try {
      const res = await wx.cloud.callFunction({
        name: "stat",
        data: {}
      });
      const stat = res.result;

      // 格式化数据
      const display = {
        today: `￥${(stat.todayIncome / 100).toFixed(2)} / ${stat.todayOrders}单 / 客单价￥${(stat.todayARPU / 100).toFixed(2)}`,
        month: `￥${(stat.monthIncome / 100).toFixed(2)} / ${stat.monthOrders}单 / 客单价￥${(stat.monthARPU / 100).toFixed(2)}`
      };

      this.setData({ stat, display });
    } catch (e) {
      console.error("获取统计失败", e);
    }
  }
});
