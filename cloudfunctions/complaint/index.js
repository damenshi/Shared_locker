const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

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
    const value = params[key]
    if (value === undefined || value === null || value === '' || (typeof value === 'string' && value.trim() === '')) {
      return { valid: false, msg: `参数错误：${key}不能为空` }
    }
    if (rule.type && typeof value !== rule.type) {
      return { valid: false, msg: `参数错误：${key}应为${rule.type}` }
    }
    if (rule.enum && !rule.enum.includes(value)) {
      return { valid: false, msg: `参数错误：${key}必须为${rule.enum.join('或')}` }
    }
    if (rule.maxLength && value.length > rule.maxLength) {
      return { valid: false, msg: `参数错误：${key}最多${rule.maxLength}字` }
    }
  }
  return { valid: true }
}

// 检查是否为超级管理员
const checkSuperAdmin = async (openid) => {
  try {
    const adminRes = await db.collection('admin_permission').where({
      openid: openid,
      type: 'super'
    }).get()
    return adminRes.data.length > 0
  } catch (err) {
    console.error('[checkSuperAdmin] 查询失败:', err)
    return false
  }
}

// 手机号验证（中国大陆手机号）
const validatePhone = (phone) => {
  if (!phone || phone.trim() === '') {
    return { valid: false, msg: '手机号不能为空' }
  }
  const cleaned = phone.trim()
  if (!/^1[3-9]\d{9}$/.test(cleaned)) {
    return { valid: false, msg: '请输入正确的11位手机号' }
  }
  return { valid: true, phone: cleaned }
}

// ========== 创建投诉 ==========
const createComplaint = async (event, openid) => {
  const { type, content, orderId, phone: inputPhone } = event

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

  let phone = ''
  let orderInfo = null

  // 如有关联订单，自动带入订单信息并验证手机号
  if (orderId) {
    let order = null
    try {
      const orderRes = await db.collection('orders').doc(orderId).get()
      order = orderRes.data
    } catch (err) {
      console.error('[createComplaint] 查询订单失败:', err)
      return { success: false, errMsg: '订单不存在' }
    }

    if (!order) {
      return { success: false, errMsg: '订单不存在' }
    }

    // 验证订单归属
    if (order.openid !== openid) {
      return { success: false, errMsg: '无权投诉此订单' }
    }

    // 使用传入的手机号，如无则使用订单手机号
    if (inputPhone && inputPhone.trim()) {
      const phoneCheck = validatePhone(inputPhone)
      if (!phoneCheck.valid) {
        return { success: false, errMsg: phoneCheck.msg }
      }
      phone = phoneCheck.phone
    } else {
      phone = order.phone || ''
    }

    orderInfo = {
      orderId: orderId,
      deviceId: order.deviceId || '',
      internalNo: order.internalNo || '',
      lockerNo: order.lockerNo || ''
    }
  } else {
    // 无关联订单，必须传入手机号
    if (!inputPhone || inputPhone.trim() === '') {
      return { success: false, errMsg: '请输入手机号' }
    }
    const phoneCheck = validatePhone(inputPhone)
    if (!phoneCheck.valid) {
      return { success: false, errMsg: phoneCheck.msg }
    }
    phone = phoneCheck.phone
  }

  // 构建投诉数据
  const complaintData = {
    openid,
    phone,
    type,
    typeText: COMPLAINT_TYPES[type].text,
    content: content.trim(),
    status: 'pending',
    statusText: COMPLAINT_STATUSES.pending.text,
    reply: '',
    handledBy: '',
    handledAt: null,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
    ...orderInfo
  }

  // 插入数据库
  try {
    const result = await db.collection('complaints').add({
      data: complaintData
    })
    return { success: true, data: { complaintId: result._id } }
  } catch (err) {
    console.error('[createComplaint] 插入投诉记录失败:', err)
    return { success: false, errMsg: '创建投诉失败，请重试' }
  }
}

// ========== 获取我的投诉列表 ==========
const getMyComplaints = async (openid) => {
  try {
    const result = await db.collection('complaints')
      .where({ openid })
      .orderBy('createdAt', 'desc')
      .get()

    return { success: true, data: result.data }
  } catch (err) {
    console.error('[getMyComplaints] 查询失败:', err)
    return { success: false, errMsg: '获取投诉列表失败' }
  }
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

  try {
    const result = await db.collection('complaints')
      .where(query)
      .orderBy('createdAt', 'desc')
      .get()

    return { success: true, data: result.data }
  } catch (err) {
    console.error('[getComplaintList] 查询失败:', err)
    return { success: false, errMsg: '获取投诉列表失败' }
  }
}

// ========== 获取投诉详情 ==========
const getComplaintDetail = async (event, openid) => {
  const { complaintId } = event
  if (!complaintId) {
    return { success: false, errMsg: '缺少投诉ID' }
  }

  let complaint = null
  try {
    const result = await db.collection('complaints').doc(complaintId).get()
    complaint = result.data
  } catch (err) {
    console.error('[getComplaintDetail] 查询投诉失败:', err)
    return { success: false, errMsg: '投诉记录不存在' }
  }

  if (!complaint) {
    return { success: false, errMsg: '投诉记录不存在' }
  }

  // 权限检查：用户只能看自己的，管理员可以看所有
  const isSuperAdmin = await checkSuperAdmin(openid)
  if (!isSuperAdmin && complaint.openid !== openid) {
    return { success: false, errMsg: '无权查看此投诉' }
  }

  return { success: true, data: complaint }
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

  // 状态变为 processing/resolved/rejected 时记录处理人
  if (['processing', 'resolved', 'rejected'].includes(status)) {
    updateData.handledBy = openid
    updateData.handledAt = db.serverDate()
  }

  try {
    await db.collection('complaints').doc(complaintId).update({
      data: updateData
    })
    return { success: true, message: `状态已更新为${COMPLAINT_STATUSES[status].text}` }
  } catch (err) {
    console.error('[updateStatus] 更新失败:', err)
    return { success: false, errMsg: '更新状态失败，投诉记录可能不存在' }
  }
}

// ========== 添加回复（管理员） ==========
const addReply = async (event, openid) => {
  // 权限检查
  const isSuperAdmin = await checkSuperAdmin(openid)
  if (!isSuperAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  const { complaintId, reply } = event
  if (!complaintId || !reply || reply.trim() === '') {
    return { success: false, errMsg: '缺少投诉ID或回复内容' }
  }

  try {
    await db.collection('complaints').doc(complaintId).update({
      data: {
        reply: reply.trim(),
        handledBy: openid,
        handledAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    return { success: true, message: '回复已提交' }
  } catch (err) {
    console.error('[addReply] 更新失败:', err)
    return { success: false, errMsg: '提交回复失败，投诉记录可能不存在' }
  }
}

exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  if (!OPENID) {
    return { success: false, errMsg: '用户未登录' }
  }

  try {
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
  } catch (err) {
    console.error('[complaint] 未捕获的异常:', err)
    return { success: false, errMsg: '服务器内部错误' }
  }
}
