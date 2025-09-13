const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 管理员openid列表（修正变量名，确保前后一致）
const ADMIN_OPENIDS = [
  'oibJq1y_nw3YV0ne3tIemICTQ7Fs'
]

// 工具函数：生成指定范围的随机数
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const batchCreateDevices = async (event) => {
  const { deviceCount } = event
  
  if (!deviceCount || deviceCount <= 0) {
    return { 
      success: false, 
      errMsg: '请指定有效的设备数量' 
    }
  }

  try {
    const maxDeviceRes = await db.collection('devices')
      .where({}) // 查询所有设备
      .field({ deviceId: true }) // 只返回deviceId字段
      .get();

    // 提取所有设备ID并解析数字部分（如从"L0002"中提取2）
    const deviceIds = maxDeviceRes.data.map(item => item.deviceId || '');
    const deviceNumbers = deviceIds
      .filter(id => /^L\d+$/.test(id)) // 筛选符合"L+数字"格式的ID
      .map(id => parseInt(id.replace('L', ''), 10)) // 提取数字部分
      .filter(num => !isNaN(num)); // 过滤无效数字

    // 计算起始序号（无现有设备则从1开始）
    const maxNumber = deviceNumbers.length > 0 ? Math.max(...deviceNumbers) : 0;
    const startNumber = maxNumber + 1;

    const devices = []
    const timestamp = Date.now()

    // 生成设备数据
    for (let i = 0; i < deviceCount; i++) {
      const currentNumber = startNumber + i; // 递增序号
      const deviceId = `L${String(currentNumber).padStart(4, '0')}`; // 格式化为L000X
      devices.push({
        deviceId: deviceId,
        isOnline: false,       // 初始离线
        lastLoginTime: null,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      })
    }

    // 批量插入devices集合
    const result = await db.collection('devices').add({
      data: devices
    })

    const createdCount = result._ids.length;
    return {
      success: true,
      count: createdCount,
      message: `成功生成 ${createdCount} 个设备`
    }
  } catch (err) {
    console.error('批量生成设备失败', err)
    return { success: false, errMsg: err.message }
  }
}

const batchCreateLockers = async (event) => {
  const { deviceId, cabinetCount, lockersPerCabinet } = event
  
  // 验证参数
  if (!deviceId || !cabinetCount || !lockersPerCabinet) {
    return { 
      success: false, 
      errMsg: '请指定设备ID、锁板数量和每个锁板的锁数量' 
    }
  }

  // 验证设备是否存在
  const deviceCheck = await db.collection('devices')
    .where({ deviceId: deviceId })
    .get()
  if (deviceCheck.data.length === 0) {
    return { 
      success: false, 
      errMsg: `设备 ${deviceId} 不存在，请先创建设备` 
    }
  }

  try {
    const lockers = []

    // 生成锁数据（关联设备）
    for (let cabinetNo = 1; cabinetNo <= cabinetCount; cabinetNo++) {
      for (let doorNo = 1; doorNo <= lockersPerCabinet; doorNo++) {
        lockers.push({
          deviceId: deviceId,    // 关联设备ID
          cabinetNo: cabinetNo,  // 锁板编号
          doorNo: doorNo,        // 锁编号
          status: 'free',        // 初始空闲
          currentOrderId: null,
          updatedAt: db.serverDate()
        })
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

// const batchCreateLockers = async (event) => {
//   // 新增deviceCount参数，指定设备数量
//   const { deviceCount = 1, cabinetCount, lockersPerCabinet } = event
  
//   // 参数验证（增加设备数量校验）
//   if (!deviceCount || !cabinetCount || !lockersPerCabinet) {
//     return { 
//       success: false, 
//       errMsg: '请指定设备数量、柜子数量和每个柜子的柜门数量' 
//     }
//   }

//   try {
//     const lockers = []
//     const timestamp = Date.now()

//     // 外层循环：设备（L0001、L0002...）
//     for (let deviceIndex = 1; deviceIndex <= deviceCount; deviceIndex++) {
//       // 设备ID格式：L0001、L0002（4位数字，不足补零）
//       const deviceId = `L${String(deviceIndex).padStart(4, '0')}`;
      
//       // 中层循环：锁板（cabinetNo，保持原有逻辑）
//       for (let cabinetNo = 1; cabinetNo <= cabinetCount; cabinetNo++) {
//         // 内层循环：锁（doorNo，保持原有逻辑）
//         for (let doorNo = 1; doorNo <= lockersPerCabinet; doorNo++) {
//           lockers.push({
//             status: 'free',
//             currentOrderId: null,
//             lastOpenAt: timestamp,
//             updatedAt: timestamp,
//             doorNo: doorNo,
//             cabinetNo: cabinetNo,
//             deviceId: deviceId  // 添加设备ID
//           })
//         }
//       }
//     }

//     // 批量插入数据库
//     const result = await db.collection('lockers').add({
//       data: lockers
//     })

//     // 检查result和stats是否存在
//     if (!result || !result.stats) {
//       console.error('批量插入返回格式异常', result)
//       return {
//         success: true,
//         count: lockers.length,
//         message: `尝试生成 ${lockers.length} 个储物柜数据（返回格式异常）`
//       }
//     }

//     // 兼容不同版本的返回字段（created或inserted）
//     const createdCount = result.stats.created || result.stats.inserted || 0
    
//     return {
//       success: true,
//       count: createdCount,
//       message: `成功生成 ${createdCount} 个储物柜数据（共请求 ${lockers.length} 个）`
//     }
//   } catch (err) {
//     console.error('批量生成储物柜失败', err)
//     return { success: false, errMsg: err.message || '批量插入数据失败' }
//   }
// }


// 生成储物柜二维码
// const generateLockerQrcodes = async (event) => {
//   const { cabinetNo = null } = event

//   try {
//     // 查询符合条件的储物柜
//     let query = db.collection('lockers')
//     if (cabinetNo) {
//       query = query.where({ cabinetNo: _.eq(cabinetNo) })
//     }
    
//     const lockers = await query.get()
    
//     if (lockers.data.length === 0) {
//       return { success: false, errMsg: '未找到对应的储物柜数据' }
//     }

//     // 生成每个储物柜的二维码
//     const qrcodeResults = []
//     for (const locker of lockers.data) {
//       // 二维码内容：包含柜子编号
//       const scene = `cabinetNo=${locker.cabinetNo}`
      
//       // 调用微信云生成二维码接口
//       const qrcode = await cloud.openapi.wxacode.getUnlimited({
//         scene,
//         page: 'pages/store/store', // 扫码后跳转的页面
//         width: 280
//       })

//       // 上传二维码到云存储
//       const uploadResult = await cloud.uploadFile({
//         cloudPath: `locker_qrcodes/${locker.cabinetNo}_${locker.doorNo}_${Date.now()}.png`,
//         fileContent: qrcode.buffer
//       })

//       // 更新储物柜记录，保存二维码地址
//       await db.collection('lockers').doc(locker._id).update({
//         data: {
//           qrcodeUrl: uploadResult.fileID,
//           updatedAt: Date.now()
//         }
//       })

//       qrcodeResults.push({
//         cabinetNo: locker.cabinetNo,
//         doorNo: locker.doorNo,
//         qrcodeUrl: uploadResult.fileID
//       })
//     }

//     return {
//       success: true,
//       count: qrcodeResults.length,
//       data: qrcodeResults
//     }
//   } catch (err) {
//     console.error('生成二维码失败', err)
//     return { success: false, errMsg: err.message }
//   }
// }

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()

  // 验证管理员权限（变量名已修正为ADMIN_OPENIDS）
  const isAdmin = ADMIN_OPENIDS.includes(OPENID)
  if (!isAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  // 管理员权限验证接口
  if (action === 'amIAdmin') {
    return { isAdmin: true }
  }
  
  //批量创建设备
  if (action === 'batchCreateDevices') {
    return await batchCreateDevices(event)
  }

  // 批量创建储物柜
  if (action === 'batchCreateLockers') {
    return await batchCreateLockers(event)
  }
  
  // 生成储物柜二维码
  if (action === 'batchCreateLockers') {
    return await batchCreateLockers(event)
  }

  return { error: 'unknown action' }
}