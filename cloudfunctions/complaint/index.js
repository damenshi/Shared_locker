const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 投诉类型常量
const COMPLAINT_TYPES = {
  refund: { code: 'refund', text: '退款问题' },
  door: { code: 'door', text: '柜门打不开' },
  other: { code: 'other', text: '其他' }
}

// 投诉状态常量
const COMPLAINT_STATUSES = {
  pending: { code: 'pending', text: '待处理' },
  processing: { code: 'processing', text: '处理中' },
  resolved: { code: 'resolved', text: '已解决' },
  rejected: { code: 'rejected', text: '已拒绝' }
}

// 参数验证
const validateParams = (params, rules) => {
  for (const [key, rule] of Object.entries(rules)) {
    if (params[key] === undefined || params[key] === null || params[key] === '') {
      return { valid: false, msg: `参数错误：${key}不能为空` }
    }
    if (rule.type && typeof params[key] !== rule.type) {
      return { valid: false, msg: `参数错误：${key}应为${rule.type}` }
    }
    if (rule.enum && !rule.enum.includes(params[key])) {
      return { valid: false, msg: `参数错误：${key}必须为${rule.enum.join('或')}` }
    }
    if (rule.maxLength && params[key].length > rule.maxLength) {
      return { valid: false, msg: `参数错误：${key}最多${rule.maxLength}字` }
    }
  }
  return { valid: true }
}

// 检查是否为超级管理员
const checkSuperAdmin = async (openid) => {
  const adminRes = await db.collection('admin_permission').where({
    openid: openid,
    type: 'super'
  }).get()
  return adminRes.data.length > 0
}

// ========== 创建投诉 ==========
const createComplaint = async (event, openid) => {
  const { type, content, orderId } = event

  // 验证参数
  const validation = validateParams(
    { type, content },
    {
      type: { enum: ['refund', 'door', 'other'] },
      content: { type: 'string', maxLength: 500 }
    }
  )
  if (!validation.valid) {
    return { success: false, errMsg: validation.msg }
  }

  // 获取用户信息
  const userRes = await db.collection('users').where({ openid }).get()
  const phone = userRes.data.length > 0 ? userRes.data[0].phone : ''

  // 构建投诉数据
  const complaintData = {
    openid,
    phone,
    type,
    typeText: COMPLAINT_TYPES[type].text,
    content,
    status: 'pending',
    statusText: COMPLAINT_STATUSES.pending.text,
    reply: '',
    handledBy: '',
    handledAt: null,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  }

  // 如有关联订单，自动带入订单信息
  if (orderId) {
    const orderRes = await db.collection('orders').doc(orderId).get()
    if (!orderRes.data) {
      return { success: false, errMsg: '订单不存在' }
    }
    const order = orderRes.data
    // 验证订单归属
    if (order.openid !== openid) {
      return { success: false, errMsg: '无权投诉此订单' }
    }
    complaintData.orderId = orderId
    complaintData.deviceId = order.deviceId || ''
    complaintData.internalNo = order.internalNo || ''
    complaintData.lockerNo = order.lockerNo || ''
  }

  // 插入数据库
  const result = await db.collection('complaints').add({
    data: complaintData
  })

  return { success: true, data: { complaintId: result._id } }
}

// ========== 获取我的投诉列表 ==========
const getMyComplaints = async (openid) => {
  const result = await db.collection('complaints')
    .where({ openid })
    .orderBy('createdAt', 'desc')
    .get()

  return { success: true, data: result.data }
}

// ========== 获取投诉列表（管理员） ==========
const getComplaintList = async (event, openid) => {
  // 权限检查：仅超级管理员
  const isSuperAdmin = await checkSuperAdmin(openid)
  if (!isSuperAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  const { status } = event
  let query = {}
  if (status && ['pending', 'processing', 'resolved', 'rejected'].includes(status)) {
    query.status = status
  }

  const result = await db.collection('complaints')
    .where(query)
    .orderBy('createdAt', 'desc')
    .get()

  return { success: true, data: result.data }
}

// ========== 获取投诉详情 ==========
const getComplaintDetail = async (event, openid) => {
  const { complaintId } = event
  if (!complaintId) {
    return { success: false, errMsg: '缺少投诉ID' }
  }

  const result = await db.collection('complaints').doc(complaintId).get()
  if (!result.data) {
    return { success: false, errMsg: '投诉记录不存在' }
  }

  // 权限检查：用户只能看自己的，管理员可以看所有
  const isSuperAdmin = await checkSuperAdmin(openid)
  if (!isSuperAdmin && result.data.openid !== openid) {
    return { success: false, errMsg: '无权查看此投诉' }
  }

  return { success: true, data: result.data }
}

// ========== 更新投诉状态（管理员） ==========
const updateStatus = async (event, openid) => {
  // 权限检查
  const isSuperAdmin = await checkSuperAdmin(openid)
  if (!isSuperAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  const { complaintId, status } = event
  if (!complaintId || !status) {
    return { success: false, errMsg: '缺少投诉ID或状态' }
  }

  if (!COMPLAINT_STATUSES[status]) {
    return { success: false, errMsg: '无效的状态值' }
  }

  const updateData = {
    status,
    statusText: COMPLAINT_STATUSES[status].text,
    updatedAt: db.serverDate()
  }

  // 状态变为 processing/resolver/rejected 时记录处理人
  if (['processing', 'resolved', 'rejected'].includes(status)) {
    updateData.handledBy = openid
    updateData.handledAt = db.serverDate()
  }

  await db.collection('complaints').doc(complaintId).update({
    data: updateData
  })

  return { success: true, message: `状态已更新为${COMPLAINT_STATUSES[status].text}` }
}

// ========== 添加回复（管理员） ==========
const addReply = async (event, openid) => {
  // 权限检查
  const isSuperAdmin = await checkSuperAdmin(openid)
  if (!isSuperAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  const { complaintId, reply } = event
  if (!complaintId || !reply) {
    return { success: false, errMsg: '缺少投诉ID或回复内容' }
  }

  await db.collection('complaints').doc(complaintId).update({
    data: {
      reply,
      handledBy: openid,
      handledAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })

  return { success: true, message: '回复已提交' }
}

exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  if (action === 'createComplaint') {
    return await createComplaint(event, OPENID)
  }
  if (action === 'getMyComplaints') {
    return await getMyComplaints(OPENID)
  }
  if (action === 'getComplaintList') {
    return await getComplaintList(event, OPENID)
  }
  if (action === 'getComplaintDetail') {
    return await getComplaintDetail(event, OPENID)
  }
  if (action === 'updateStatus') {
    return await updateStatus(event, OPENID)
  }
  if (action === 'addReply') {
    return await addReply(event, OPENID)
  }

  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}
