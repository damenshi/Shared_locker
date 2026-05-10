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
  resolved: { code: 'resolved', text: '已解决' }
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

// ========== 通知超级管理员 ==========
const notifyAdmins = async (complaint) => {
  try {
    // 查询所有超级管理员
    const adminRes = await db.collection('admin_permission')
      .where({ type: 'super' })
      .get()

    if (!adminRes.data || adminRes.data.length === 0) {
      console.log('[notifyAdmins] 未找到超级管理员')
      return
    }

    // 从数据库 system_configs 集合读取模板ID
    let templateId = ''
    try {
      const configRes = await db.collection('system_configs')
        .where({ key: 'complaint_template_id' })
        .get()
      if (configRes.data && configRes.data.length > 0) {
        templateId = configRes.data[0].value || ''
      }
    } catch (e) {
      console.warn('[notifyAdmins] 读取模板ID配置失败:', e.message)
    }
    if (!templateId) {
      console.log('[notifyAdmins] 未配置订阅消息模板ID，跳过通知')
      return
    }

    // 构造消息数据（模板字段：thing2=投诉原因, thing5=备注）
    const typeText = COMPLAINT_TYPES[complaint.type]?.text || complaint.type || '其他'
    // thing2 最多20字符
    let reasonText = typeText + '：' + (complaint.content || '')
    if (reasonText.length > 20) reasonText = reasonText.substring(0, 17) + '...'
    // thing5 最多20字符
    let remarkText = '请尽快处理'

    const sendResults = []
    for (const admin of adminRes.data) {
      try {
        const result = await cloud.openapi.subscribeMessage.send({
          touser: admin.openid,
          templateId: templateId,
          page: `pages/admin/complaints`,
          data: {
            thing2: { value: reasonText },   // 投诉原因
            thing5: { value: remarkText }    // 备注
          }
        })
        sendResults.push({ openid: admin.openid, success: true })
        console.log(`[notifyAdmins] 通知管理员成功: ${admin.openid}`)

        // 记录通知时间，用于前端判断是否需要重新订阅
        try {
          await db.collection('admin_permission').doc(admin._id).update({
            data: { lastNotifiedAt: db.serverDate() }
          })
        } catch (e) {
          console.warn('[notifyAdmins] 更新lastNotifiedAt失败:', e.message)
        }
      } catch (err) {
        // 用户未订阅时会报错，不阻断主流程
        console.warn(`[notifyAdmins] 通知管理员失败: ${admin.openid}`, err.errCode, err.errMsg)
        sendResults.push({ openid: admin.openid, success: false, errCode: err.errCode })
      }
    }

    return sendResults
  } catch (err) {
    console.error('[notifyAdmins] 通知管理员异常:', err)
    return null
  }
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

    // 异步通知管理员（不阻塞返回）
    notifyAdmins({
      type: complaintData.type,
      content: complaintData.content,
      createdAt: complaintData.createdAt
    }).catch(err => {
      console.error('[createComplaint] 通知管理员失败（非阻塞）:', err)
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
  if (status && ['pending', 'resolved'].includes(status)) {
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

  // 状态变为 resolved 时记录处理人
  if (['resolved'].includes(status)) {
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
        status: 'resolved',
        statusText: COMPLAINT_STATUSES.resolved.text,
        handledBy: openid,
        handledAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    return { success: true, message: '回复已提交，投诉已标记为已解决' }
  } catch (err) {
    console.error('[addReply] 更新失败:', err)
    return { success: false, errMsg: '提交回复失败，投诉记录可能不存在' }
  }
}

// ========== 用户追加回复 ==========
const addUserReply = async (event, openid) => {
  const { complaintId, reply } = event
  if (!complaintId || !reply || reply.trim() === '') {
    return { success: false, errMsg: '缺少投诉ID或回复内容' }
  }

  let complaint = null
  try {
    const result = await db.collection('complaints').doc(complaintId).get()
    complaint = result.data
  } catch (err) {
    console.error('[addUserReply] 查询投诉失败:', err)
    return { success: false, errMsg: '投诉记录不存在' }
  }

  if (!complaint) {
    return { success: false, errMsg: '投诉记录不存在' }
  }

  // 权限检查：只能回复自己的投诉
  if (complaint.openid !== openid) {
    return { success: false, errMsg: '无权操作此投诉' }
  }

  try {
    await db.collection('complaints').doc(complaintId).update({
      data: {
        userReply: reply.trim(),
        userReplyAt: db.serverDate(),
        status: 'pending',
        statusText: COMPLAINT_STATUSES.pending.text,
        updatedAt: db.serverDate()
      }
    })
    return { success: true, message: '回复已提交，等待管理员处理' }
  } catch (err) {
    console.error('[addUserReply] 更新失败:', err)
    return { success: false, errMsg: '提交回复失败，请重试' }
  }
}

// ========== 删除投诉（管理员） ==========
const deleteComplaint = async (event, openid) => {
  // 权限检查
  const isSuperAdmin = await checkSuperAdmin(openid)
  if (!isSuperAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  const { complaintId } = event
  if (!complaintId) {
    return { success: false, errMsg: '缺少投诉ID' }
  }

  try {
    await db.collection('complaints').doc(complaintId).remove()
    return { success: true, message: '投诉已删除' }
  } catch (err) {
    console.error('[deleteComplaint] 删除失败:', err)
    return { success: false, errMsg: '删除投诉失败，记录可能不存在' }
  }
}

// ========== 获取订阅消息配置 ==========
const getSubscribeConfig = async () => {
  try {
    const configRes = await db.collection('system_configs')
      .where({ key: 'complaint_template_id' })
      .get()
    const templateId = (configRes.data && configRes.data.length > 0)
      ? configRes.data[0].value || ''
      : ''
    return { success: true, data: { templateId } }
  } catch (err) {
    console.error('[getSubscribeConfig] 查询失败:', err)
    return { success: false, errMsg: '获取配置失败' }
  }
}

// ========== 获取管理员通知状态 ==========
const getAdminNotifyStatus = async (openid) => {
  try {
    const adminRes = await db.collection('admin_permission')
      .where({ openid: openid, type: 'super' })
      .get()

    if (!adminRes.data || adminRes.data.length === 0) {
      return { success: true, data: { lastNotifiedAt: null } }
    }

    return { success: true, data: { lastNotifiedAt: adminRes.data[0].lastNotifiedAt || null } }
  } catch (err) {
    console.error('[getAdminNotifyStatus] 查询失败:', err)
    return { success: false, errMsg: '获取通知状态失败' }
  }
}

// ========== 初始化订阅消息模板ID到数据库 ==========
const initSubscribeConfig = async (templateId, openid) => {
  // 权限检查
  const isSuperAdmin = await checkSuperAdmin(openid)
  if (!isSuperAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  if (!templateId) {
    return { success: false, errMsg: '请提供模板ID' }
  }
  try {
    // 检查是否已存在
    const existing = await db.collection('system_configs')
      .where({ key: 'complaint_template_id' })
      .get()

    if (existing.data && existing.data.length > 0) {
      // 已存在，更新
      await db.collection('system_configs')
        .doc(existing.data[0]._id)
        .update({ data: { value: templateId } })
      return { success: true, message: '模板ID已更新' }
    } else {
      // 不存在，新增
      await db.collection('system_configs').add({
        data: { key: 'complaint_template_id', value: templateId }
      })
      return { success: true, message: '模板ID已添加' }
    }
  } catch (err) {
    console.error('[initSubscribeConfig] 失败:', err)
    return { success: false, errMsg: err.message }
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
    if (action === 'addUserReply') {
      return await addUserReply(event, OPENID)
    }
    if (action === 'deleteComplaint') {
      return await deleteComplaint(event, OPENID)
    }
    if (action === 'getSubscribeConfig') {
      return await getSubscribeConfig()
    }
    if (action === 'initSubscribeConfig') {
      return await initSubscribeConfig(event.templateId, OPENID)
    }
    if (action === 'getAdminNotifyStatus') {
      return await getAdminNotifyStatus(OPENID)
    }

    return { error: 'unknown action', errMsg: '未找到对应的操作' }
  } catch (err) {
    console.error('[complaint] 未捕获的异常:', err)
    return { success: false, errMsg: '服务器内部错误' }
  }
}
