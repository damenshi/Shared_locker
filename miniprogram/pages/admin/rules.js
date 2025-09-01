// miniprogram/pages/admin/rules.js
Page({
  data: {
    rule: {},
    display: {}
  },

  onLoad() {
    this.loadRule();
  },

  async loadRule() {
    try {
      // const res = await wx.cloud.callFunction({
      //   name: "getRule",
      //   data: {}
      // });
      const res = await wx.cloud.callFunction({ 
        name: "billing", 
        data: { action: "getRules" } 
      });
      const rule = res.result;

      // 格式化显示字符串
      const display = {
        free: `免费${rule.freeMinutes}分钟`,
        first: `首${rule.firstPeriodMinutes}分钟￥${(rule.firstPeriodPrice / 100).toFixed(2)}`,
        unit: `续费每${rule.unitMinutes}分钟￥${(rule.unitPrice / 100).toFixed(2)}`,
        cap: `封顶￥${(rule.capPrice / 100).toFixed(2)}`,
        deposit: `押金￥${(rule.depositPrice / 100).toFixed(2)}`
      };

      this.setData({ rule, display });
    } catch (e) {
      console.error("获取规则失败", e);
    }
  },

  // 提交修改规则
  async saveRule(e) {
    const updatedRule = e.detail.value;
    try {
      // await wx.cloud.callFunction({
      //   name: "updateRule",
      //   data: updatedRule
      // });
      await wx.cloud.callFunction({ 
        name: "billing", 
        data: { 
          action: "setRules", 
          rule: updatedRule } 
        });

      wx.showToast({ title: "保存成功", icon: "success" });
      this.loadRule(); // 刷新显示
    } catch (err) {
      wx.showToast({ title: "保存失败", icon: "none" });
      console.error(err);
    }
  }
});
