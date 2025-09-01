// 管理员openid列表（示例：请替换为你的openid）
const ADMIN_OPENIDS = [
  // 'o_xxx_your_openid'
]

module.exports = {
  isAdmin(openid){ return ADMIN_OPENIDS.includes(openid) },
  ADMIN_OPENIDS
}
