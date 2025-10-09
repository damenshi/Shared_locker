const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

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

exports.main = async (event, context) => {
  const { action } = event

  if (action === 'getDevicesDeposit') {
    try {
      const { deviceId } = event;

      // 参数校验
      const validation = validateParams(event, {
        deviceId: {type: 'string'}
      })
      if (!validation.valid) {
        return { success: false, errMsg: validation.msg }
      }

      const result = await db.collection('devices')
        .where({
          deviceId:deviceId
        })
        .field({
          deviceDeposit: true
        })
        .get()
      
      if(result.data?.length === 0)
        throw new Error('获取设备收费标准失败');
      return { success: true, data: result.data[0].deviceDeposit }
    } catch (err) {
      console.error('获取设备收费标准失败', err)
      return { success: false, errMsg: `${err.message}` }
    }
  }

  if (action === 'getDeviceAddress') {
    try {
      const { deviceId } = event;

      // 参数校验
      const validation = validateParams(event, {
        deviceId: {type: 'string'}
      })
      if (!validation.valid) {
        return { success: false, errMsg: validation.msg }
      }

      const result = await db.collection('devices')
        .where({
          deviceId:deviceId
        })
        .field({
          deviceAddress : true
        })
        .get()
      
      if(result.data?.length === 0)
        throw new Error('获取设备地址失败');

      return { success: true, data: result.data[0].deviceAddress}
    } catch (err) {
      console.error('获取设备地址失败', err)
      return { success: false, errMsg: `${err.message}` }
    }
  }

  if (action === 'getDevices') {

    try {
      const deviceInfo = await db.collection('devices').get()

      if (deviceInfo.data.length === 0) {
        throw new Error('暂无设备');
      }

      const devices = deviceInfo.data;
      return { success: true, data: devices }

    } catch (err) {
      console.error('查询设备列表失败', { error: err.message })
      return { success: false, errMsg: err.message }
    }
  }
  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}

