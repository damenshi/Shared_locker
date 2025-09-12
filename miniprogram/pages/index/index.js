const db = wx.cloud.database()
Page({
  data:{ phone:'', code:'' },
  onPhone(e){ this.setData({phone:e.detail.value}) },
  onCode(e){ this.setData({code:e.detail.value}) },
  goStore(){
    if(!/^\d{11}$/.test(this.data.phone)) return wx.showToast({title:'手机号不正确', icon:'none'})
    wx.navigateTo({ url: `/pages/store/store?phone=${this.data.phone}&code=${this.data.code}` })
  },
  goTake(){
    console.log('取包按钮被点击，准备跳转'); // 新增打印
  console.log('传递的参数：', { phone: this.data.phone, code: this.data.code }); // 打印参数
    wx.navigateTo({ 
      url: `/pages/take/take?mode=take&phone=${this.data.phone}&code=${this.data.code}` 
    });
  },
  goAdmin(){ wx.navigateTo({ url:'/pages/admin/admin' }) },
  goMine() {
    wx.navigateTo({ url: '/pages/mine/mine' });
  },
})
