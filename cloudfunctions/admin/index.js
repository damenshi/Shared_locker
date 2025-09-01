const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const { isAdmin } = require('./common/admin')

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()
  if(action === 'amIAdmin'){
    return { isAdmin: isAdmin(OPENID) }
  }
  return { error:'unknown action' }
}
