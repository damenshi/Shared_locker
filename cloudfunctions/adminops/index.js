const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  try {
    return await db.collection('devices').where({
      _id: db.command.exists(true)
    }).update({
      data: { isFree: event.isFree } // 根据传入参数决定开启或关闭
    })
  } catch (e) {
    return e
  }
}