const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 获取计费规则
async function getRule() {
  const r = await db.collection('billingRules').doc('default').get().catch(() => null)
  return r ? r.data : {
    freeMinutes: 15,
    firstPeriodMinutes: 60,
    firstPeriodPrice: 300,
    unitMinutes: 30,
    unitPrice: 100,
    capPrice: 2000,
    depositPrice: 500
  }
}

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()

  // 模拟支付成功（个人账号测试用）
  if (action === 'mockPaySuccess') {
    const { orderId } = event;
    
    return await db.runTransaction(async transaction => {
      // 1. 查询订单
      const orderDoc = await transaction.collection('orders').doc(orderId).get();
      if (!orderDoc.data) {
        throw new Error('订单不存在');
      }
      
      // 2. 验证订单状态（必须是待支付）
      if (orderDoc.data.status !== '待支付') {
        throw new Error('订单状态异常，无法支付');
      }
      
      // 3. 更新订单状态为"进行中"，模拟支付成功
      await transaction.collection('orders').doc(orderId).update({
        data: {
          status: '进行中',
          payAmount: orderDoc.data.prepay,
          payTime: Date.now(),
          updatedAt: Date.now()
        }
      });
      
      return { success: true };
    }).catch(err => {
      return { success: false, errMsg: err.message };
    });
  }

  // 创建订单（核心修改：与柜子状态强绑定）
  if (action === 'createOrder') {
    const { lockerId, phone, code } = event
  
    return await db.runTransaction(async transaction => {

      const lockerDoc = await transaction.collection('lockers').doc(lockerId).get({
        readFresh: true
      })
      
      // 严格验证柜子状态（必须空闲且无关联订单）
      if (!lockerDoc.data || lockerDoc.data.status !== 'free' || lockerDoc.data.currentOrderId !== null) {
        throw new Error('柜门不可用（状态异常或已被占用）')
      }
  
      // 2. 构建订单数据
      const rule = await getRule()
      const now = Date.now()
      const pre = { 
        rent: rule.firstPeriodPrice || 0, 
        deposit: rule.depositPrice || 0 
      }
      const order = {
        openid: OPENID,
        phone,
        code: code || String(Math.floor(Math.random() * 900000) + 100000),
        lockerId,
        cabinetNo: lockerDoc.data.cabinetNo, // 新增：记录柜号（与柜子关联）
        doorNo: lockerDoc.data.doorNo,
        size: lockerDoc.data.size || 'M',
        status: '待支付',
        startTime: now,
        payAmount: 0,
        prepay: pre.rent + pre.deposit,
        deposit: pre.deposit,
        createdAt: now,
        updatedAt: now
      }
  
      // 3. 创建订单
      const addRes = await transaction.collection('orders').add({ data: order })
  
      // 4. 更新柜子状态为占用（与存包逻辑一致）
      await transaction.collection('lockers').doc(lockerId).update({
        data: { 
          status: 'occupied', 
          currentOrderId: addRes._id,
          updatedAt: now // 新增：更新时间戳
        }
      })
  
      return { orderId: addRes._id }
    }).catch(err => {
      console.error('创建订单失败：', err.message);
      return { error: err.message };
    });
  }
  
  // 获取单个订单详情（新增：明确返回状态）
  if (action === 'getOrder') {
    const { id } = event
    try {
      const doc = await db.collection('orders').doc(id).get()
      if (!doc.data) {
        return { success: false, errMsg: '订单不存在' };
      }
      return { success: true, data: doc.data }; // 统一返回格式
    } catch (err) {
      return { success: false, errMsg: err.message };
    }
  }

  // 完成订单（取件后）
  if (action === 'finishOrder') {
    const { orderId } = event

    return await db.runTransaction(async transaction => {
      // 1. 获取订单
      const orderDoc = await transaction.collection('orders').doc(orderId).get()
      if (!orderDoc.data) {
        throw new Error('订单不存在')
      }
      
      // 2. 验证订单状态
      if (orderDoc.data.status !== '进行中') {
        throw new Error('订单状态不可完成')
      }

      // 3. 计算最终费用
      const now = Date.now()
      const duration = Math.ceil((now - orderDoc.data.startTime) / 60000) // 分钟
      const rule = await getRule()
      
      let rent = 0
      if (duration <= rule.firstPeriodMinutes) {
        rent = rule.firstPeriodPrice
      } else {
        const extraMinutes = duration - rule.firstPeriodMinutes
        const extraPeriods = Math.ceil(extraMinutes / rule.unitMinutes)
        rent = rule.firstPeriodPrice + extraPeriods * rule.unitPrice
      }
      
      // 应用封顶价格
      if (rent > rule.capPrice) {
        rent = rule.capPrice
      }
      
      const total = rent + (orderDoc.data.deposit || 0)

      // 4. 更新订单状态
      await transaction.collection('orders').doc(orderId).update({
        data: {
          status: '已完成',
          endTime: now,
          rent,
          payAmount: total,
          updatedAt: now
        }
      })

      // 5. 释放柜子（修复：将currentOrderId设为null而非空字符串）
      if (orderDoc.data.lockerId) {
        await transaction.collection('lockers').doc(orderDoc.data.lockerId).update({
          data: {
            status: 'free',
            currentOrderId: null, // 与存包逻辑保持一致
            updatedAt: now
          }
        })
      }

      return { success: true, rent, total }
    }).catch(err => {
      return { success: false, errMsg: err.message };
    });
  }


  // 强制结束订单（管理员用）
  if (action === 'forceFinish') {
    const { orderId } = event

    return await db.runTransaction(async transaction => {
      // 1. 获取订单
      const orderDoc = await transaction.collection('orders').doc(orderId).get()
      if (!orderDoc.data) {
        throw new Error('订单不存在')
      }

      // 2. 更新订单状态
      await transaction.collection('orders').doc(orderId).update({
        data: {
          status: '已强制结束',
          endTime: Date.now(),
          updatedAt: Date.now()
        }
      })

      // 3. 释放柜子（修复：将currentOrderId设为null）
      if (orderDoc.data.lockerId) {
        await transaction.collection('lockers').doc(orderDoc.data.lockerId).update({
          data: {
            status: 'free',
            currentOrderId: null,
            updatedAt: Date.now()
          }
        })
      }

      return { success: true }
    }).catch(err => {
      return { success: false, errMsg: err.message };
    });
  }

  // 退款操作（保持不变）
  if (action === 'refund') {
    const { id } = event
    try {
      const o = (await db.collection('orders').doc(id).get()).data
      await db.collection('orders').doc(id).update({ 
        data: { 
          status: '已退款', 
          refundAmount: o.payAmount || 0, 
          updatedAt: Date.now() 
        } 
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, errMsg: err.message };
    }
  }

  // 通过手机号和取件码查询订单（保持不变）
  if (action === 'queryByPhoneAndCode') {
  const { phone, code } = event;
  try {
    const { data } = await db.collection('orders')
      .where({
        phone: phone,
        code: code,
        status: _.in(['进行中', '已支付'])
      })
      .field({
        _id: true,
        cabinetNo: true,
        status: true,
        lockerId: true,
        createdAt: true // 用于排序
      })
      .orderBy('createdAt', 'desc') // 按创建时间倒序，最新的订单排在最前
      .limit(1)
      .get();

    if (data.length > 0) {
      // 打印日志，便于调试（生产环境可删除）
      console.log(`匹配到订单：ID=${data[0]._id}，柜号=${data[0].cabinetNo}，创建时间=${new Date(data[0].createdAt)}`);
      return { success: true, data: data[0] };
    } else {
      console.log(`未找到手机号${phone}、取件码${code}的有效订单`);
      return { success: true, data: null };
    }
  } catch (err) {
    return { success: false, errMsg: err.message };
  }
}

  // 新增：根据订单ID查询（供开柜校验用）
  if (action === 'queryById') {
    const { orderId } = event;
    try {
      const doc = await db.collection('orders').doc(orderId).get();
      if (doc.data) {
        return { success: true, data: doc.data };
      } else {
        return { success: false, errMsg: '订单不存在' };
      }
    } catch (err) {
      return { success: false, errMsg: err.message };
    }
  }

  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}