const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 管理员openid列表
const ADMIN_OPENIDS = [
  'oFThN1yR0zzomK0r1LRwvx4GSqoU'
]

const batchCreateLockers = async (event) => {
  const { internalNo, deviceAddress, deviceDeposit, cabinetCount, lockersPerCabinet } = event
  
  // 验证参数
  if (!internalNo || !deviceAddress || !deviceDeposit || !cabinetCount || !lockersPerCabinet) {
    return { 
      success: false, 
      errMsg: '请指定设备ID、设备地址、设备收费标准、锁板数量和每个锁板的锁数量' 
    }
  }

  // 验证设备是否存在
  const deviceCheck = await db.collection('devices')
    .where({ internalNo: internalNo })
    .get()
  if (deviceCheck.data.length === 0) {
    return { 
      success: false, 
      errMsg: `设备 ${deviceId} 不存在，请先创建设备` 
    }
  }else{
    await db.collection('devices')
      .where({ internalNo: internalNo })
      .update({
        data: {
          cabinetCount: parseInt(cabinetCount),  // 锁板数量
          doorCount: parseInt(lockersPerCabinet),// 锁数量
          isConfigured: true,                    // 标记为已配置
          deviceAddress: deviceAddress,          // 设备地址
          deviceDeposit: deviceDeposit,
          updatedAt: db.serverDate()             // 更新时间
        }
      });
  }

  const deviceId = deviceCheck.data[0].deviceId;
  try {
    const lockers = []
    let lockerNo = 1;

    // 生成锁数据（关联设备）
    for (let cabinetNo = 1; cabinetNo <= cabinetCount; cabinetNo++) {
      for (let doorNo = 1; doorNo <= lockersPerCabinet; doorNo++) {
        lockers.push({
          deviceId: deviceId,    // 关联设备ID
          internalNo: internalNo,
          deviceAddress: deviceAddress,
          deviceDeposit: deviceDeposit,
          cabinetNo: cabinetNo,  // 锁板编号
          doorNo: doorNo,        // 锁编号
          lockerNo: lockerNo,
          status: 'free',        // 初始空闲
          currentOrderId: null,
          currentUserPhone: null,
          updatedAt: db.serverDate()
        })
        lockerNo++;
      }
    }

    // 批量插入lockers集合
    const result = await db.collection('lockers').add({
      data: lockers
    })

    const createdCount = result._ids.length;
    return {
      success: true,
      count: createdCount,
      message: `为设备 ${deviceId} 成功生成 ${createdCount} 个锁具`
    }
  } catch (err) {
    console.error('批量生成锁具失败', err)
    return { success: false, errMsg: err.message }
  }
}

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()

  // 验证管理员权限
  console.log("OPENID:", OPENID);
  const isAdmin = ADMIN_OPENIDS.includes(OPENID)
  if (!isAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  // 管理员权限验证接口
  if (action === 'amIAdmin') {
    return { isAdmin: true }
  }

  // 批量创建储物柜
  if (action === 'batchCreateLockers') {
    return await batchCreateLockers(event)
  }

  return { error: 'unknown action' }
}