const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 管理员openid列表（直接整合管理员判断逻辑）
const ADMIN_OPENIDS = [
  // 'o_xxx_your_openid' // 替换为实际管理员openid
]

// 工具函数：生成指定范围的随机数
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// 批量生成储物柜数据
const batchCreateLockers = async (event) => {
  const { cabinetCount, lockersPerCabinet} = event
  
  // 参数验证
  if (!cabinetCount || !lockersPerCabinet) {
    return { success: false, errMsg: '请指定柜子数量和每个柜子的柜门数量' }
  }

  try {
    const lockers = []
    const timestamp = Date.now()

    // 批量生成locker数据
    for (let cabinetNo = 1; cabinetNo <= cabinetCount; cabinetNo++) {
      for (let doorNo = 1; doorNo <= lockersPerCabinet; doorNo++) {
        // 随机分配尺寸        
        lockers.push({
          status: 'free',
          currentOrderId: null,
          lastOpenAt: timestamp,
          updatedAt: timestamp,
          doorNo: doorNo,
          cabinetNo: cabinetNo
        })
      }
    }

    // 批量插入数据库
    const result = await db.collection('lockers').add({
      data: lockers
    })

    return {
      success: true,
      count: result.stats.updated,
      message: `成功生成 ${cabinetCount * lockersPerCabinet} 个储物柜数据`
    }
  } catch (err) {
    console.error('批量生成储物柜失败', err)
    return { success: false, errMsg: err.message }
  }
}

// 生成储物柜二维码
const generateLockerQrcodes = async (event) => {
  const { cabinetNo = null } = event

  try {
    // 查询符合条件的储物柜
    let query = db.collection('lockers')
    if (cabinetNo) {
      query = query.where({ cabinetNo: _.eq(cabinetNo) })
    }
    
    const lockers = await query.get()
    
    if (lockers.data.length === 0) {
      return { success: false, errMsg: '未找到对应的储物柜数据' }
    }

    // 生成每个储物柜的二维码
    const qrcodeResults = []
    for (const locker of lockers.data) {
      // 二维码内容：包含柜子编号
      const scene = `cabinetNo=${locker.cabinetNo}`
      
      // 调用微信云生成二维码接口
      const qrcode = await cloud.openapi.wxacode.getUnlimited({
        scene,
        page: 'pages/store/store', // 扫码后跳转的页面
        width: 280
      })

      // 上传二维码到云存储
      const uploadResult = await cloud.uploadFile({
        cloudPath: `locker_qrcodes/${locker.cabinetNo}_${locker.doorNo}_${Date.now()}.png`,
        fileContent: qrcode.buffer
      })

      // 更新储物柜记录，保存二维码地址
      await db.collection('lockers').doc(locker._id).update({
        data: {
          qrcodeUrl: uploadResult.fileID,
          updatedAt: Date.now()
        }
      })

      qrcodeResults.push({
        cabinetNo: locker.cabinetNo,
        doorNo: locker.doorNo,
        qrcodeUrl: uploadResult.fileID
      })
    }

    return {
      success: true,
      count: qrcodeResults.length,
      data: qrcodeResults
    }
  } catch (err) {
    console.error('生成二维码失败', err)
    return { success: false, errMsg: err.message }
  }
}

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()
  
  // 验证管理员权限
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
  
  // 生成储物柜二维码
  if (action === 'generateLockerQrcodes') {
    return await generateLockerQrcodes(event)
  }

  return { error: 'unknown action' }
}