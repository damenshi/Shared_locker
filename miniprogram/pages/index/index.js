const db = wx.cloud.database()
const app = getApp(); 
Page({
  data:{ phone:'', password:'', deviceId: ''},

  onLoad() {
    if (app.globalData.deviceId) {
      this.setData({
        deviceId: app.globalData.deviceId
      });
      console.log('index页面获取到的deviceId:', app.globalData.deviceId);
    }

    if (app.globalData.openid) {
      this.setData({
        openid: app.globalData.openid
      });
      console.log('index页面获取到的openid:', app.globalData.openid);
    }
  },

  onPhone(e){ this.setData({phone:e.detail.value}) },
  onPassword(e){ this.setData({password:e.detail.value}) },
  goStore(){
    if(!/^\d{11}$/.test(this.data.phone)) return wx.showToast({title:'手机号不正确', icon:'none'})
    wx.navigateTo({ url: `/pages/store/store?phone=${this.data.phone}&password=${this.data.password}` })
  },
  goTake(){
    console.log('取包按钮被点击，准备跳转'); // 新增打印
  console.log('传递的参数：', { phone: this.data.phone, password: this.data.password }); // 打印参数
    wx.navigateTo({ 
      url: `/pages/take/take?mode=take&phone=${this.data.phone}&password=${this.data.password}` 
    });
  },
  goAdmin(){ wx.navigateTo({ url:'/pages/admin/admin' }) },

  goMine() {
    wx.removeStorageSync('userInfo');
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      // 已经授权过，直接跳转
      wx.navigateTo({ 
        url: `/pages/mine/mine?phone=${this.data.phone}&password=${this.data.password}` 
      });
    } else {
      wx.getUserProfile({
        desc: '用于完善个人资料',
        success: (res) => {
          const userInfo = res.userInfo;
          this.setData({ userInfo });
          wx.setStorageSync('userInfo', userInfo);
          // 授权成功后再跳转
          wx.navigateTo({ 
            url: `/pages/mine/mine?phone=${this.data.phone}&password=${this.data.password}` 
          });
        },
        fail: () => {
          wx.showToast({
            title: '授权后可使用完整功能',
            icon: 'none'
          });
        }
      });
    }
  }  
})
