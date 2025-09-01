Page({
  data:{ orders:[] },
  onShow(){ this.fetch() },
  fetch(){
    wx.cloud.callFunction({ name:'order', data:{ action:'listOrders', statusIndex:0 }}).then(res=>{
      this.setData({ orders: res.result.data || [] })
    })
  },
  go(e){ wx.navigateTo({ url:`/pages/orders/detail?id=${e.currentTarget.dataset.id}` }) },
  force(e){
    wx.cloud.callFunction({ name:'order', data:{ action:'forceFinish', id:e.currentTarget.dataset.id }}).then(_=>{
      wx.showToast({title:'OK'}); this.fetch()
    })
  },
  refund(e){
    wx.cloud.callFunction({ name:'order', data:{ action:'refund', id:e.currentTarget.dataset.id, mock:true }}).then(_=>{
      wx.showToast({title:'已退款'}); this.fetch()
    })
  }
})
