// 商户健康度管理：支付/投诉统计、连续失败标记限制、自动切换商户
// 仅供其他云函数通过 cloud.callFunction 调用（入口有 OPENID 拦截，小程序端无法直接调用）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PAY_FAIL_THRESHOLD = 3 // 连续下单失败多少次后标记限制

// 当日日期字符串（UTC+8）
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

// 投诉率是否超限（recordComplaint 触发判断与 autoSwitch 候选过滤共用的统一规则）
function isOverComplaintRate(m, rateLimit) {
  if (!m || !(rateLimit > 0)) return false
  const orders = m.todayOrders || 0
  const complaints = m.todayComplaints || 0
  const rate = orders > 0 ? (complaints / orders) * 100 : (complaints > 0 ? 100 : 0)
  return rate >= rateLimit
}

// 全局限额（所有商户统一标准）；读取失败一律兜底为不限，绝不影响支付主流程
async function getGlobalLimits() {
  try {
    const res = await db.collection('system_configs').doc('merchant_limits').get()
    const d = res.data || {}
    return {
      dailyOrderLimit: Number(d.dailyOrderLimit) || 0,
      complaintRateLimit: Number(d.complaintRateLimit) || 0
    }
  } catch (e) {
    console.warn('[getGlobalLimits] 读取失败，按不限处理:', e.message)
    return { dailyOrderLimit: 0, complaintRateLimit: 0 }
  }
}

// 计数自增（跨天懒重置），三段式原子操作防并发丢计数
// field: 'todayOrders' | 'todayComplaints'
async function incWithDayReset(merchantId, field) {
  const today = todayStr()
  const col = db.collection('merchant_configs')
  const isOrder = field === 'todayOrders'

  // 自增载荷
  const incData = { [field]: _.inc(1) }
  if (isOrder) {
    incData.totalOrders = _.inc(1)
    incData.consecutivePayFails = 0 // 支付成功说明商户恢复，清零连续失败
  } else {
    incData.totalComplaints = _.inc(1)
  }

  // 快路径：同一天直接自增
  let res = await col.where({ _id: merchantId, statsDate: today }).update({ data: incData })
  if (res.stats.updated > 0) return

  // 慢路径：跨天，条件更新保证只有一个并发请求真正执行重置
  const resetData = { statsDate: today, todayOrders: 0, todayComplaints: 0, [field]: 1 }
  if (isOrder) {
    resetData.totalOrders = _.inc(1)
    resetData.consecutivePayFails = 0
  } else {
    resetData.totalComplaints = _.inc(1)
  }
  res = await col.where({ _id: merchantId, statsDate: _.neq(today) }).update({ data: resetData })

  if (res.stats.updated === 0) {
    // 另一并发请求已完成重置 → 回退到自增，计数不丢
    await col.where({ _id: merchantId, statsDate: today }).update({ data: incData })
  }
}

// 自动切换到下一个可用商户（同 appid、非限制、未达今日全局限额/投诉率阈值，按 order 升序）
async function autoSwitch(appid, reason, excludeId) {
  if (!appid) {
    console.error('[autoSwitch] 缺少 appid，无法切换')
    return { switched: false }
  }
  const today = todayStr()
  const limits = await getGlobalLimits()
  const candidates = await db.collection('merchant_configs')
    .where({ appid, isActive: false, status: _.neq('restricted') })
    .orderBy('order', 'asc')
    .get()

  for (const m of candidates.data) {
    if (excludeId && m._id === excludeId) continue
    // 跳过不参与自动轮换的商户（备用号，只能手动切换）
    if (m.autoRotate === false) continue
    // 跳过今日已达订单限额的
    if (limits.dailyOrderLimit > 0 && m.statsDate === today && (m.todayOrders || 0) >= limits.dailyOrderLimit) continue
    // 跳过今日投诉率已达阈值的
    if (m.statsDate === today && isOverComplaintRate(m, limits.complaintRateLimit)) continue

    let switched = false
    let aborted = false
    await db.runTransaction(async (t) => {
      if (excludeId) {
        const src = await t.collection('merchant_configs').doc(excludeId).get()
        if (!src.data || !src.data.isActive) {
          aborted = true // 已被其他请求切走，中止且不再尝试其他候选
          return
        }
      }
      await t.collection('merchant_configs')
        .where({ appid, isActive: true })
        .update({ data: { isActive: false } })
      await t.collection('merchant_configs').doc(m._id).update({
        data: { isActive: true, updatedAt: db.serverDate() }
      })
      switched = true
    })

    if (switched) {
      console.log(`[autoSwitch] 原因=${reason}: 已切换到商户 ${m.name}(${m._id})`)
      return { switched: true, to: m._id, name: m.name }
    }
    if (aborted) {
      console.log(`[autoSwitch] 原因=${reason}: 源商户已被其他请求切走，本次中止`)
      return { switched: false, aborted: true }
    }
  }

  console.error(`[autoSwitch] 告警: appid=${appid} 原因=${reason} 无可用商户，保持现状，需人工介入！`)
  return { switched: false }
}

// 支付成功计数 + 订单限额检查
async function recordPaySuccess(event) {
  const { merchantId } = event
  if (!merchantId) return { success: false, errMsg: '缺少 merchantId' }

  await incWithDayReset(merchantId, 'todayOrders')

  const d = (await db.collection('merchant_configs').doc(merchantId).get()).data
  if (d && d.isActive) {
    const limits = await getGlobalLimits()
    if (limits.dailyOrderLimit > 0 && (d.todayOrders || 0) >= limits.dailyOrderLimit) {
      console.log(`[recordPaySuccess] 商户 ${merchantId} 已达今日限额 ${limits.dailyOrderLimit}，触发切换`)
      await autoSwitch(d.appid, 'daily_limit', merchantId)
    }
  }
  return { success: true }
}

// 投诉计数（按 complaintId 去重）+ 投诉率检查
async function recordComplaint(event) {
  const { merchantId, complaintId } = event
  if (!merchantId || !complaintId) return { success: false, errMsg: '缺少 merchantId 或 complaintId' }

  // 去重：同一 complaintId 只计一次（微信回调可能重试）
  try {
    await db.collection('merchant_complaint_ids').add({
      data: {
        _id: complaintId,
        merchantId,
        appid: event.appid || '',
        createdAt: db.serverDate()
      }
    })
  } catch (e) {
    // 区分"重复投诉"与"真错误"（如集合未创建）：回查该投诉是否已存在
    let exists = false
    try {
      await db.collection('merchant_complaint_ids').doc(complaintId).get()
      exists = true
    } catch (e2) { /* 不存在 */ }
    if (exists) {
      console.log(`[recordComplaint] 投诉 ${complaintId} 已计过数，跳过`)
      return { success: true, counted: false, reason: 'duplicate' }
    }
    // 真错误（如 merchant_complaint_ids 集合未创建）：打错误日志，继续计数（best-effort，宁可重复不可漏计）
    console.error('[recordComplaint] 去重记录写入失败，请检查 merchant_complaint_ids 集合是否已创建:', e.message)
  }

  await incWithDayReset(merchantId, 'todayComplaints')

  const d = (await db.collection('merchant_configs').doc(merchantId).get()).data
  if (d && d.isActive) {
    const limits = await getGlobalLimits()
    if (isOverComplaintRate(d, limits.complaintRateLimit)) {
      console.log(`[recordComplaint] 商户 ${merchantId} 今日投诉率达阈值 ${limits.complaintRateLimit}%，触发切换`)
      await autoSwitch(d.appid, 'complaint_rate', merchantId)
    }
  }
  return { success: true, counted: true }
}

// 下单失败计数，连续 3 次标记限制并切换
async function recordPayFail(event) {
  const { merchantId, errCode } = event
  if (!merchantId) return { success: false, errMsg: '缺少 merchantId' }

  await db.collection('merchant_configs').doc(merchantId).update({
    data: { consecutivePayFails: _.inc(1) }
  })

  // 条件更新：只有第一个越过阈值的并发请求能把状态置为 restricted
  const res = await db.collection('merchant_configs').where({
    _id: merchantId,
    status: _.neq('restricted'),
    consecutivePayFails: _.gte(PAY_FAIL_THRESHOLD)
  }).update({
    data: {
      status: 'restricted',
      statusReason: `连续下单失败${PAY_FAIL_THRESHOLD}次(最近错误码:${errCode || 'unknown'})`,
      statusUpdatedAt: db.serverDate()
    }
  })

  if (res.stats.updated > 0) {
    console.warn(`[recordPayFail] 商户 ${merchantId} 连续下单失败${PAY_FAIL_THRESHOLD}次，已标记限制`)
    const d = (await db.collection('merchant_configs').doc(merchantId).get()).data
    if (d && d.isActive) {
      await autoSwitch(d.appid, 'pay_fail', merchantId)
    }
  }
  return { success: true }
}

// 一次性迁移：给存量商户文档补齐新字段
async function initStats() {
  const all = await db.collection('merchant_configs').get()
  let patched = 0
  for (const m of all.data) {
    const patch = {}
    if (m.status === undefined) patch.status = 'normal'
    if (m.statsDate === undefined) patch.statsDate = ''
    const numFields = ['todayOrders', 'todayComplaints', 'totalOrders', 'totalComplaints',
      'consecutivePayFails']
    for (const f of numFields) {
      if (m[f] === undefined) patch[f] = 0
    }
    if (Object.keys(patch).length > 0) {
      await db.collection('merchant_configs').doc(m._id).update({ data: patch })
      patched++
    }
  }
  console.log(`[initStats] 共 ${all.data.length} 个商户，补齐 ${patched} 个`)
  return { success: true, total: all.data.length, patched }
}

exports.main = async (event, context) => {
  // 安全拦截：小程序端调用必带 OPENID，拒绝；云函数间调用/控制台测试无 OPENID，放行
  const wxContext = cloud.getWXContext()
  if (wxContext.OPENID) {
    console.warn('[merchant] 拒绝小程序端直接调用, OPENID:', wxContext.OPENID)
    return { success: false, errMsg: 'forbidden' }
  }

  const { action } = event
  console.log('[merchant] action:', action, 'merchantId:', event.merchantId || '')

  try {
    if (action === 'recordPaySuccess') return await recordPaySuccess(event)
    if (action === 'recordComplaint') return await recordComplaint(event)
    if (action === 'recordPayFail') return await recordPayFail(event)
    if (action === 'autoSwitch') return await autoSwitch(event.appid, event.reason || 'manual', event.excludeId)
    if (action === 'initStats') return await initStats()
    return { success: false, errMsg: 'unknown action' }
  } catch (e) {
    console.error('[merchant] 处理异常:', e)
    return { success: false, errMsg: e.message }
  }
}
