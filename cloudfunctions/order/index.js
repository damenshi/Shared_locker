const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 常量定义：订单状态和固定费用配置
const CONSTANTS = {
  ORDER_STATUSES: {
    PENDING_PAY: '待支付',
    IN_PROGRESS: '进行中',
    COMPLETED: '已完成',
    FORCE_FINISHED: '已强制结束',
    REFUNDED: '已退款'
  },
  VALID_STATUSES_FOR_QUERY: ['进行中', '已支付'],
  // 固定费用配置（单位：分）
  FIXED_PRICES: {
    rent: 0,       // 固定租金
    deposit: 15,    // 固定押金
    total: 15       // 租金+押金总和
  }
}

// 工具函数：参数校验
const validateParams = (params, requiredFields = []) => {
  for (const field of requiredFields) {
    if (params[field] === undefined || params[field] === null) {
      return { valid: false, msg: `参数错误：${field}不能为空` }
    }
    // 字符串类型验证
    if (typeof params[field] === 'string' && params[field].trim() === '') {
      return { valid: false, msg: `参数错误：${field}不能为空白字符串` }
    }
  }
  return { valid: true }
}

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()
  const now = Date.now()

  // 1. 模拟支付成功（个人账号测试用）
  if (action === 'mockPaySuccess') {
    const { orderId } = event
    
    // 参数校验
    const validation = validateParams(event, ['orderId'])
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }
    
    try {
      return await db.runTransaction(async transaction => {
        // 查询订单
        const orderDoc = await transaction.collection('orders').doc(orderId).get()
        if (!orderDoc.data) {
          throw new Error('订单不存在')
        }
        const order = orderDoc.data;

        // 验证订单状态
        if (order.status !== CONSTANTS.ORDER_STATUSES.PENDING_PAY) {
          throw new Error(`订单状态异常，当前状态：${order.status}，无法支付`)
        }
        
        // 查询用户账户
        const userDoc = await transaction.collection('users').doc(order.userId).get()
        if (!userDoc.data) throw new Error('用户不存在')
        const user = userDoc.data

        // 支付成功：更新用户押金（
        const newDeposit = user.deposit + order.deposit; // 累加押金

        // 1. 更新用户账户
        await transaction.collection('users').doc(user._id).update({
          data: { deposit: newDeposit, updatedAt: now }
        })

        // 更新订单状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.IN_PROGRESS,
            payAmount: CONSTANTS.FIXED_PRICES.total,
            payTime: now,
            updatedAt: now
          }
        })

        return { success: true }
      })
    } catch (err) {
      console.error('模拟支付失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 2. 创建订单
  if (action === 'createOrder') {
    const { lockerId, phone, code } = event
  
    // 参数校验
    const validation = validateParams(event, ['lockerId', 'phone'])
    if (!validation.valid) {
      return { error: validation.msg }
    }
    
    // 手机号格式验证
    if (!/^\d{11}$/.test(phone)) {
      return { error: '手机号格式不正确' }
    }

    try {
      return await db.runTransaction(async transaction => {
        // 验证柜子状态
        const lockerDoc = await transaction.collection('lockers')
          .doc(lockerId)
          .get({ readFresh: true })
        
        if (!lockerDoc.data) {
          throw new Error('柜子不存在')
        }
        
        // 严格验证柜子状态
        if (lockerDoc.data.status !== 'free' || lockerDoc.data.currentOrderId !== null) {
          throw new Error('柜门不可用（状态异常或已被占用）')
        }
        
        // 获取或创建用户账户
      const getUserAccount = async (phone) => {
        const user = await transaction.collection('users').where({ phone }).get();
        if (user.data.length > 0) {
          return user.data[0];
        } else {
          // 新建账户
          const res = await transaction.collection('users').add({
            data: {
              phone,
              deposit: 0,
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
          });
          return { _id: res._id, phone, deposit: 0 };
        }
      }
      const user = await getUserAccount(phone);

        // 构建订单数据（使用固定费用）
        const order = {
          openid: OPENID,
          phone,
          code: code || String(Math.floor(Math.random() * 900000) + 100000),
          lockerId,
          cabinetNo: lockerDoc.data.cabinetNo,
          doorNo: lockerDoc.data.doorNo,
          size: lockerDoc.data.size || 'M',
          status: CONSTANTS.ORDER_STATUSES.PENDING_PAY,
          startTime: now,
          payAmount: 0,
          prepay: CONSTANTS.FIXED_PRICES.total,  // 固定预付款
          deposit: CONSTANTS.FIXED_PRICES.deposit, // 固定押金
          rent: CONSTANTS.FIXED_PRICES.rent,     // 固定租金
          userId: user._id, //关联用户ID
          createdAt: now,
          updatedAt: now
        }

        // 创建订单
        const addRes = await transaction.collection('orders').add({ data: order })
        
        // 更新柜子状态为占用
        await transaction.collection('lockers').doc(lockerId).update({
          data: { 
            status: 'occupied', 
            currentOrderId: addRes._id,
            updatedAt: now
          }
        })
        
        return { orderId: addRes._id }
      })
    } catch (err) {
      console.error('创建订单失败', { error: err.message, lockerId, phone })
      return { error: err.message }
    }
  }
  
  // 3. 获取单个订单详情
  if (action === 'getOrder') {
    const { id } = event
    
    // 参数校验
    const validation = validateParams(event, ['id'])
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const doc = await db.collection('orders').doc(id).get()
      if (!doc.data) {
        return { success: false, errMsg: '订单不存在' }
      }
      return { success: true, data: doc.data }
    } catch (err) {
      console.error('获取订单详情失败', { orderId: id, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 4. 完成订单（取件后）
  if (action === 'finishOrder') {
    const { orderId } = event
    
    // 参数校验
    const validation = validateParams(event, ['orderId'])
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      return await db.runTransaction(async transaction => {
        // 获取订单
        const orderDoc = await transaction.collection('orders').doc(orderId).get()
        if (!orderDoc.data) {
          throw new Error('订单不存在')
        }
        
        // 验证订单状态
        if (orderDoc.data.status !== CONSTANTS.ORDER_STATUSES.IN_PROGRESS) {
          throw new Error(`订单状态不可完成，当前状态：${orderDoc.data.status}`)
        }

        // 更新订单状态（使用固定费用）
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.COMPLETED,
            endTime: now,
            // 保持固定费用不变
            payAmount: CONSTANTS.FIXED_PRICES.total,
            updatedAt: now
          }
        })

        // 释放柜子
        if (orderDoc.data.lockerId) {
          await transaction.collection('lockers').doc(orderDoc.data.lockerId).update({
            data: {
              status: 'free',
              currentOrderId: null,
              updatedAt: now
            }
          })
        }

        return { 
          success: true, 
          rent: CONSTANTS.FIXED_PRICES.rent, 
          total: CONSTANTS.FIXED_PRICES.total 
        }
      })
    } catch (err) {
      console.error('完成订单失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 5. 强制结束订单（管理员用）
  if (action === 'forceFinish') {
    const { orderId } = event
    
    // 参数校验
    const validation = validateParams(event, ['orderId'])
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      return await db.runTransaction(async transaction => {
        // 获取订单
        const orderDoc = await transaction.collection('orders').doc(orderId).get()
        if (!orderDoc.data) {
          throw new Error('订单不存在')
        }

        // 更新订单状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.FORCE_FINISHED,
            endTime: now,
            updatedAt: now
          }
        })

        // 释放柜子
        if (orderDoc.data.lockerId) {
          await transaction.collection('lockers').doc(orderDoc.data.lockerId).update({
            data: {
              status: 'free',
              currentOrderId: null,
              updatedAt: now
            }
          })
        }

        return { success: true }
      })
    } catch (err) {
      console.error('强制结束订单失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 6. 退款操作
  if (action === 'refund') {
    const { id } = event
    
    // 参数校验
    const validation = validateParams(event, ['id'])
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    try {
      const orderDoc = await db.collection('orders').doc(id).get()
      if (!orderDoc.data) {
        return { ok: false, errMsg: '订单不存在' }
      }
      
      // 验证订单是否可退款
      if (![CONSTANTS.ORDER_STATUSES.COMPLETED, CONSTANTS.ORDER_STATUSES.IN_PROGRESS].includes(orderDoc.data.status)) {
        return { ok: false, errMsg: `订单状态为${orderDoc.data.status}，不可退款` }
      }

      await db.collection('orders').doc(id).update({ 
        data: { 
          status: CONSTANTS.ORDER_STATUSES.REFUNDED, 
          refundAmount: CONSTANTS.FIXED_PRICES.total, // 退还固定总金额
          refundTime: now,
          updatedAt: now 
        } 
      })
      return { ok: true }
    } catch (err) {
      console.error('退款操作失败', { orderId: id, error: err.message })
      return { ok: false, errMsg: err.message }
    }
  }

  // 7. 通过手机号和取件码查询订单
  if (action === 'queryByPhoneAndCode') {
    const { phone, code } = event;
    
    // 参数校验
    const validation = validateParams(event, ['phone', 'code'])
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const { data } = await db.collection('orders')
        .where({
          phone,
          code,
          status: _.in(CONSTANTS.VALID_STATUSES_FOR_QUERY)
        })
        .field({
          _id: true,
          cabinetNo: true,
          status: true,
          lockerId: true,
          createdAt: true
        })
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get()

      if (data.length > 0) {
        console.log(`匹配到订单：ID=${data[0]._id}，柜号=${data[0].cabinetNo}`)
        return { success: true, data: data[0] }
      } else {
        console.log(`未找到手机号${phone}、取件码${code}的有效订单`)
        return { success: true, data: null }
      }
    } catch (err) {
      console.error('查询订单失败', { phone, code, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 8. 根据订单ID查询
  if (action === 'queryById') {
    const { orderId } = event;
    
    // 参数校验
    const validation = validateParams(event, ['orderId'])
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const doc = await db.collection('orders').doc(orderId).get()
      if (doc.data) {
        return { success: true, data: doc.data }
      } else {
        return { success: false, errMsg: '订单不存在' }
      }
    } catch (err) {
      console.error('查询订单失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}
