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
    REFUNDED: '已退款',
    CANCELLED: '已取消'
  },
  VALID_STATUSES_FOR_QUERY: ['进行中'],
  FIXED_DEPOSIT: 15  // 固定押金15元
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

  // 1. 模拟支付成功
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
        const newDeposit = user.deposit + CONSTANTS.FIXED_DEPOSIT;

        // 1. 更新用户账户
        await transaction.collection('users').doc(user._id).update({
          data: { deposit: newDeposit, updatedAt: db.serverDate() }
        })

        // 更新订单状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.IN_PROGRESS,
            payAmount: CONSTANTS.FIXED_DEPOSIT,
            payTime: db.serverDate(),
            updatedAt: db.serverDate()
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
    const { lockerId, phone, password} = event
  
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
                createdAt: db.serverDate(),
                updatedAt: db.serverDate()
              }
            });
            return { _id: res._id, phone, deposit: 0 };
          }
        }
        const user = await getUserAccount(phone);
      
      // 判断用户是否有余额
      const hasEnoughDeposit = user.deposit >= CONSTANTS.FIXED_DEPOSIT;

        // 构建订单数据
        const order = {
          openid: OPENID,
          phone,
          password: password || String(Math.floor(Math.random() * 9000) + 1000),
          lockerId,
          deviceId: lockerDoc.data.deviceId,
          cabinetNo: lockerDoc.data.cabinetNo,
          doorNo: lockerDoc.data.doorNo,
          size: lockerDoc.data.size || 'M',
          status: hasEnoughDeposit 
            ? CONSTANTS.ORDER_STATUSES.IN_PROGRESS 
            : CONSTANTS.ORDER_STATUSES.PENDING_PAY,
          startTime: db.serverDate(),
          deposit: CONSTANTS.FIXED_DEPOSIT, // 固定押金
          userId: user._id, //关联用户ID
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }

        // 创建订单
        const addRes = await transaction.collection('orders').add({ data: order })
        
        // 更新柜子状态为占用
        await transaction.collection('lockers').doc(lockerId).update({
          data: { 
            status: 'occupied', 
            currentOrderId: addRes._id,
            updatedAt: db.serverDate()
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

  // 4. 完成订单
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

        // 更新订单状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.COMPLETED,
            endTime: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })

        return { 
          success: true, 
          deposit: CONSTANTS.FIXED_DEPOSIT
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
            endTime: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })

        // 释放柜子
        if (orderDoc.data.lockerId) {
          await transaction.collection('lockers').doc(orderDoc.data.lockerId).update({
            data: {
              status: 'free',
              currentOrderId: null,
              updatedAt: db.serverDate()
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
      return await db.runTransaction(async transaction => {
        const orderDoc = await transaction.collection('orders').doc(id).get()
        if (!orderDoc.data) {
          throw new Error('订单不存在')
        }
      
      const order = orderDoc.data;
      // 验证订单是否可退款
      if (![CONSTANTS.ORDER_STATUSES.COMPLETED, CONSTANTS.ORDER_STATUSES.IN_PROGRESS].includes(orderDoc.data.status)) {
        return { ok: false, errMsg: `订单状态为${orderDoc.data.status}，不可退款` }
      }

      // 查询用户账户
      const userDoc = await transaction.collection('users').doc(order.userId).get()
      if (!userDoc.data) throw new Error('用户不存在')
      const user = userDoc.data

      // 退还押金
      await transaction.collection('users').doc(user._id).update({
        data: {
          deposit: user.deposit - CONSTANTS.FIXED_DEPOSIT,
          updatedAt: now
        }
      })

      await db.collection('orders').doc(id).update({ 
        data: { 
          status: CONSTANTS.ORDER_STATUSES.REFUNDED, 
          refundAmount: CONSTANTS.FIXED_DEPOSIT,
          refundTime: db.serverDate(),
          updatedAt: db.serverDate() 
        } 
      })
      return { ok: true }
      })
    } catch (err) {
      console.error('退款操作失败', { orderId: id, error: err.message })
      return { ok: false, errMsg: err.message }
    }
  }

  // 7. 通过手机号和取件码查询订单
  if (action === 'queryByPhoneAndPassword') {
    const { phone, password, deviceId} = event;
    
    // 参数校验
    const validation = validateParams(event, ['phone', 'password'])
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const { data } = await db.collection('orders')
        .where({
          phone,
          password,
          deviceId,
          status: _.in(CONSTANTS.VALID_STATUSES_FOR_QUERY)
        })
        .field({
          _id: true,
          deviceId: true,
          cabinetNo: true,
          doorNo: true,
          status: true,
          lockerId: true,
          createdAt: true
        })
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get()

      if (data.length > 0) {
        console.log(`匹配到订单：ID=${data[0]._id}，柜门=${data[0].doorNo}`)
        return { success: true, data: data[0] }
      } else {
        console.log(`未找到手机号${phone}、取件码${password}的有效订单`)
        return { success: true, data: null }
      }
    } catch (err) {
      console.error('查询订单失败', { phone, password, error: err.message })
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

  if (action === 'recoverOrder') {
    const { orderId, targetStatus } = event;
  
    // 参数校验
    const validation = validateParams(event, ['orderId', 'targetStatus']);

    if (!validation.valid) {
      return { success: false, errMsg: validation.msg };
    }
    
    const allowedStatus = ['已取消'];
    if (!allowedStatus.includes(targetStatus)) {
      return { success: false, errMsg: `参数错误：targetStatus允许值为${allowedStatus.join(',')}` };
    }

    try {
      // 1. 查询订单当前状态
      const orderRes = await db.collection('orders').doc(orderId).get();
      if (!orderRes.data) {
        return { success: false, errMsg: `订单 ${orderId} 不存在` };
      }
      const order = orderRes.data;
  
      // 2. 验证是否需要恢复（仅对异常状态的订单操作）
      const abnormalStatuses = ['进行中', '待支付']; 
      if (!abnormalStatuses.includes(order.status)) {
        return { 
          success: false, 
          errMsg: `订单当前状态为${order.status}，无需恢复` 
        };
      }
  
      // 3. 更新订单状态为目标状态
      await db.collection('orders').doc(orderId).update({
        data: {
          status: targetStatus,
          recoverAt: db.serverDate(), // 记录恢复时间
          updatedAt: db.serverDate()
        }
      });
  
      return { 
        success: true, 
        message: `订单 ${orderId} 已从${order.status}恢复为${targetStatus}`,
        orderId
      };
    } catch (err) {
      console.error(`恢复订单 ${orderId} 失败`, err);
      return { success: false, errMsg: `恢复订单失败：${err.message}` };
    }
  }

  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}
