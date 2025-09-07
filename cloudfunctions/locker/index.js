const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 常量定义：集中管理固定值
const CONSTANTS = {
  LOCKER_STATUSES: ['free', 'occupied'], // 柜子允许的状态
  OPERATION_TYPES: ['store', 'take']     // 允许的操作类型
}

// 工具函数：参数校验
const validateParams = (params, rules) => {
  for (const [key, rule] of Object.entries(rules)) {
    if (params[key] === undefined || params[key] === null) {
      return { valid: false, msg: `参数错误：${key}不能为空` }
    }
    if (rule.type && typeof params[key] !== rule.type) {
      return { 
        valid: false, 
        msg: `参数错误：${key}应为${rule.type}，实际是${typeof params[key]}` 
      }
    }
    if (rule.enum && !rule.enum.includes(params[key])) {
      return { 
        valid: false, 
        msg: `参数错误：${key}必须为${rule.enum.join('或')}` 
      }
    }
  }
  return { valid: true }
}

// 工具函数：恢复柜子状态为空闲
const recoverLockerStatus = async (doorNo) => {
  try {
    const locker = await db.collection('lockers')
      .where({ doorNo })
      .get()
      
    if (locker.data.length > 0) {
      await db.collection('lockers').doc(locker.data[0]._id).update({
        data: {
          status: 'free',
          currentOrderId: null,
          updatedAt: Date.now()
        }
      })
      console.log(`柜门 ${doorNo} 已自动恢复为空闲状态`)
      return true
    }
    return false
  } catch (err) {
    console.error(`恢复柜门 ${doorNo} 状态失败`, err)
    return false
  }
}

exports.main = async (event, context) => {
  const { action } = event

  // 1. 查询空闲柜子
  if (action === 'listFree') {
    try {
      const { cabinetNo } = event;

      const whereCondition = { 
        status: 'free',
        currentOrderId: _.eq(null)
      };
      if (cabinetNo !== undefined && cabinetNo !== null) {
        whereCondition.cabinetNo = parseInt(cabinetNo, 10);
      }

      const result = await db.collection('lockers')
        .where(whereCondition)
        .field({
          _id: true,
          doorNo: true,
          size: true,
          status: true,
          currentOrderId: true,
          cabinetNo: true
        })
        .get()

      return { success: true, data: result.data }
    } catch (err) {
      console.error('查询空闲柜子失败', err)
      return { success: false, errMsg: `查询空闲柜子失败：${err.message}` }
    }
  }

  // 2. 开门操作
  if (action === 'openDoor') {
    console.log('=== 执行开柜操作 ===', event)
    const { doorNo, orderId, type, cabinetNo} = event

    // 参数校验
    const validation = validateParams(event, {
      doorNo: { type: 'number' },
      orderId: { type: 'string' },
      type: { enum: CONSTANTS.OPERATION_TYPES },
      cabinetNo: { type: 'number' } 
    })
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    const HARDWARE_MAPPING = {
      1: { ip: '192.168.1.101', port: 8080, deviceKey: 'locker-1' },
      2: { ip: '192.168.1.102', port: 8080, deviceKey: 'locker-2' },
      3: { ip: '192.168.1.103', port: 8080, deviceKey: 'locker-3' }
      // 其他柜号的硬件配置...
    };

    const callHardwareOpen = async (cabinetNo, doorNo) => {
      // 1. 获取对应柜号的硬件信息
      const hardware = HARDWARE_MAPPING[cabinetNo];
      if (!hardware) {
        throw new Error(`未配置柜号 ${cabinetNo} 的硬件信息`);
      }
  
      try {
        // 2. 实际调用硬件接口（示例为HTTP请求，根据硬件协议修改）
        const axios = require('axios');
        const response = await axios.post(
          `http://${hardware.ip}:${hardware.port}/openDoor`,
          {
            deviceKey: hardware.deviceKey,
            doorNo: doorNo,
            timestamp: Date.now()
          },
          { timeout: 5000 }  // 5秒超时设置
        );
  
        // 3. 验证硬件返回结果
        if (response.data.code !== 200 || !response.data.success) {
          throw new Error(`硬件响应异常: ${response.data.msg || '未知错误'}`);
        }
  
        return true;
      } catch (err) {
        throw new Error(`柜号 ${cabinetNo} 开柜失败: ${err.message}`);
      }
    };

    try {
      return await db.runTransaction(async transaction => {
        // 查询柜子信息
        const lockerQuery = await transaction.collection('lockers')
          .where({ doorNo, cabinetNo})
          .get({ readFresh: true })

        if (lockerQuery.data.length === 0) {
          throw new Error(`柜门 ${doorNo} 不存在`)
        }

        const locker = lockerQuery.data[0]
        const lockerId = locker._id
        const now = Date.now()

        // 存包开柜逻辑
        if (type === 'store') {
          // 状态校验
          if (locker.status !== 'occupied' || locker.currentOrderId !== orderId) {
            throw new Error(
              `存包失败：柜门 ${doorNo} 状态异常（当前：${locker.status}，关联订单：${locker.currentOrderId}）`
            )
          }

          // 订单校验
          const orderQuery = await transaction.collection('orders').doc(orderId).get()
          if (!orderQuery.data) {
            throw new Error(`订单 ${orderId} 不存在`)
          }
          if (!['进行中', '已支付'].includes(orderQuery.data.status)) {
            throw new Error(`订单 ${orderId} 未支付，无法开柜`)
          }
          if (orderQuery.data.doorNo !== doorNo) {
            throw new Error(
              `订单 ${orderId} 关联柜门不匹配（订单：${orderQuery.data.doorNo}，当前：${doorNo}）`
            )
          }

          // 模拟硬件开柜
          const openSuccess = true; // 实际项目中替换为硬件接口调用
          // const openSuccess = await callHardwareOpen(doorNo, cabinetNo);
          if (!openSuccess) {
            throw new Error(`柜门 ${doorNo} 硬件开柜失败`)
          }

          // 更新柜子状态
          await transaction.collection('lockers').doc(lockerId).update({
            data: {
              status: 'occupied',
              currentOrderId: orderId,
              lastOpenAt: now,
              updatedAt: now
            }
          })

          // 更新订单信息
          await transaction.collection('orders').doc(orderId).update({
            data: { doorNo, cabinetNo, updatedAt: now }
          })

          return { 
            ok: true, 
            message: `存包成功，柜门 ${doorNo} 已打开`, 
            doorNo 
          }
        }

        // 取包开柜逻辑
        if (type === 'take') {
          // 状态校验
          if (locker.status !== 'occupied' || locker.currentOrderId !== orderId) {
            throw new Error(
              `取包失败：柜门 ${doorNo} 与订单不匹配（当前关联：${locker.currentOrderId}，传入：${orderId}）`
            )
          }

          // 模拟硬件开柜
          const openSuccess = true; // 实际项目中替换为硬件接口调用
          if (!openSuccess) {
            throw new Error(`柜门 ${doorNo} 硬件开柜失败`)
          }

          // 更新柜子状态为空闲
          await transaction.collection('lockers').doc(lockerId).update({
            data: {
              status: 'free',
              currentOrderId: null,
              lastOpenAt: now,
              updatedAt: now
            }
          })

          return { 
            ok: true, 
            message: `取包成功，柜门 ${doorNo} 已打开`, 
            doorNo,
            cabinetNo
          }
        }
      })
    } catch (err) {
      console.error('开柜操作失败', {
        doorNo,
        cabinetNo,
        orderId,
        message: err.message,
        stack: err.stack
      })

      // 失败时尝试恢复柜子状态
      await recoverLockerStatus(doorNo)
      return { ok: false, errMsg: err.message }
    }
  }

  // 3. 更新柜子状态
  if (action === 'updateStatus') {
    const { lockerId, status, orderId } = event

    // 参数校验
    const validation = validateParams(event, {
      lockerId: { type: 'string' },
      status: { enum: CONSTANTS.LOCKER_STATUSES }
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }
    if (status === 'occupied' && (!orderId || typeof orderId !== 'string')) {
      return { success: false, errMsg: '标记为占用状态时，orderId不能为空且必须为字符串' }
    }

    try {
      const updateData = {
        status,
        updatedAt: Date.now()
      }
      // 占用状态需关联订单，空闲状态需清空订单
      updateData.currentOrderId = status === 'occupied' ? orderId : null

      await db.collection('lockers').doc(lockerId).update({ data: updateData })
      return { success: true, message: `柜状态已更新为${status}` }
    } catch (err) {
      console.error('更新柜子状态失败', err)
      // 占用状态更新失败时，自动恢复为空闲
      if (status === 'occupied') {
        try {
          await db.collection('lockers').doc(lockerId).update({
            data: { status: 'free', currentOrderId: null, updatedAt: Date.now() }
          })
          return { success: false, errMsg: `${err.message}，已自动恢复为空闲状态` }
        } catch (recoverErr) {
          console.error('恢复状态失败', recoverErr)
        }
      }
      return { success: false, errMsg: `更新状态失败：${err.message}` }
    }
  }

  // 4. 恢复柜子状态为空闲
  if (action === 'recoverLocker') {
    const { doorNo, cabinetNo} = event

    // 参数校验
    const validation = validateParams(event, {
      doorNo: { type: 'number' },
      cabinetNo: { type: 'number' } 
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const locker = await db.collection('lockers').where({ doorNo, cabinetNo}).get()
      
      if (locker.data.length === 0) {
        return { success: false, errMsg: `未找到柜门${doorNo}的记录` }
      }

      await db.collection('lockers').doc(locker.data[0]._id).update({
        data: {
          status: 'free',
          currentOrderId: null,
          updatedAt: Date.now()
        }
      })
      
      return { success: true, message: `柜门 ${doorNo} 已恢复为空闲状态` }
    } catch (err) {
      console.error('恢复柜子状态失败', err)
      return { success: false, errMsg: `恢复柜子状态失败：${err.message}` }
    }
  }

  // 5. 根据柜门查询柜号
  if (action === 'getByIdByNo') {
    const { doorNo } = event

    // 参数校验
    const validation = validateParams(event, {
      doorNo: { type: 'number' }
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const res = await db.collection('lockers').where({ doorNo }).get()
      
      if (res.data.length > 0) {
        return { 
          success: true, 
          lockerId: res.data[0]._id, 
          data: res.data[0] 
        }
      } else {
        return { success: false, errMsg: `未找到柜门${doorNo}的记录` }
      }
    } catch (err) {
      console.error('查询柜门失败', err)
      return { success: false, errMsg: `查询柜门失败：${err.message}` }
    }
  }

  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}