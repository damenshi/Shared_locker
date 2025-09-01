const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function dayStart(ts){ const d=new Date(ts); d.setHours(0,0,0,0); return d.getTime() }
function monthStart(ts){ const d=new Date(ts); d.setDate(1); d.setHours(0,0,0,0); return d.getTime() }

exports.main = async (event, context) => {
  const { action = 'overview' } = event // 默认使用 overview 动作
  if(action === 'overview'){
    const now = Date.now()
    const ds = dayStart(now), ms = monthStart(now)
    const today = await db.collection('orders').where({ updatedAt: _.gte(ds), status: _.in(['已完成','已退款','已支付']) }).get()
    const month = await db.collection('orders').where({ updatedAt: _.gte(ms), status: _.in(['已完成','已退款','已支付']) }).get()
    const sum = arr => arr.reduce((a,b)=> a+(b.payAmount||0), 0)
    const ti = sum(today.data), to = today.data.length
    const mi = sum(month.data), mo = month.data.length
    return { data:{
      todayIncome: ti, todayOrders: to, todayARPU: to? Math.round(ti/to):0,
      monthIncome: mi, monthOrders: mo, monthARPU: mo? Math.round(mi/mo):0
    }}
  }
  return { error:'unknown action' }
}
