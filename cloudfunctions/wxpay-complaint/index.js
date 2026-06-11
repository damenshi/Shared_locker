const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const Pay = require('wechatpay-node-v3')
const crypto = require('crypto')
const axios = require('axios')
const fs = require('fs')

// ==========================================
// 常量
// ==========================================
const ORDER_STATUSES = {
  PENDING_PAY: '待支付',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  FORCE_FINISHED: '已强制结束',
  CANCELLED: '已取消',
  CLOSED: '已关闭',
  REFUNDED: '已退款'
}

const WECHAT_PAY_BASE = 'https://api.mch.weixin.qq.com'

// ==========================================
// 商户配置获取
// ==========================================
async function getMerchantConfigById(merchantId) {
  if (!merchantId) return null
  try {
    const res = await db.collection('merchant_configs').doc(merchantId).get()
    return res.data && Object.keys(res.data).length > 0 ? res.data : null
  } catch (e) {
    console.error('获取商户配置失败:', e)
    return null
  }
}

async function getAllMerchantConfigs() {
  try {
    const res = await db.collection('merchant_configs')
      .orderBy('order', 'asc')
      .get()
    return res.data
  } catch (e) {
    console.error('获取所有商户配置失败:', e)
    return []
  }
}

// ==========================================
// Pay 客户端初始化
// ==========================================
async function getClient(merchantConfig) {
  if (!merchantConfig) {
    throw new Error('未找到商户配置')
  }

  const privateKey = merchantConfig.privateKey || fs.readFileSync('../order/private/apiclient_key.pem', 'utf8')
  const publicKey = merchantConfig.publicCert || fs.readFileSync('../order/private/apiclient_cert.pem', 'utf8')

  return new Pay({
    mchid: merchantConfig.mchid,
    appid: merchantConfig.appid,
    serial_no: merchantConfig.merchantSerialNo,
    publicKey: publicKey,
    privateKey: privateKey
  })
}

// ==========================================
// V3 签名请求（用于投诉 API）
// ==========================================
function sign(method, path, body, merchantConfig) {
  const nonceStr = crypto.randomBytes(16).toString('hex')
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const bodyStr = body ? JSON.stringify(body) : ''

  const message = `${method}\n${path}\n${timestamp}\n${nonceStr}\n${bodyStr}\n`
  const privateKey = merchantConfig.privateKey || fs.readFileSync('../order/private/apiclient_key.pem', 'utf8')

  const signature = crypto.createSign('RSA-SHA256')
    .update(message)
    .sign(privateKey, 'base64')

  const auth = `WECHATPAY2-SHA256-RSA2048 mchid="${merchantConfig.mchid}",serial_no="${merchantConfig.merchantSerialNo}",timestamp="${timestamp}",nonce_str="${nonceStr}",signature="${signature}"`

  return { auth, timestamp, nonceStr }
}

async function v3Request(method, path, body, merchantConfig) {
  const url = `${WECHAT_PAY_BASE}${path}`
  const { auth } = sign(method, path, body, merchantConfig)

  try {
    const res = await axios({
      method,
      url,
      data: body,
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 10000
    })

    return res.data
  } catch (err) {
    if (err.response) {
      console.error('[v3Request] 请求失败:', err.response.status, JSON.stringify(err.response.data))
    } else {
      console.error('[v3Request] 请求异常:', err.message)
    }
    throw err
  }
}

// ==========================================
// 自动退款
// ==========================================
async function autoRefund(order, merchantConfig) {
  const client = await getClient(merchantConfig)
  const refundFee = order.refundAmount !== undefined ? order.refundAmount : order.deposit
  const outRefundNo = `refund_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`

  const refundParams = {
    out_trade_no: order.outTradeNo || order._id,
    transaction_id: order.transactionId,
    out_refund_no: outRefundNo,
    amount: {
      refund: Math.round(refundFee * 100),
      total: Math.round(order.deposit * 100),
      currency: 'CNY'
    },
    notify_url: merchantConfig.notify_url
  }

  const refundRes = await client.refunds(refundParams)

  if (!refundRes || refundRes.status !== 200) {
    throw new Error(`退款请求失败: ${refundRes?.message || '未知错误'}`)
  }
  if (refundRes.data && refundRes.data.status !== 'SUCCESS' && refundRes.data.status !== 'PROCESSING') {
    throw new Error(`退款失败: ${refundRes.data?.message || refundRes.data?.status || '未知错误'}`)
  }

  // 更新订单状态
  await db.collection('orders').doc(order._id).update({
    data: {
      status: ORDER_STATUSES.REFUNDED,
      refundTime: new Date(),
      refundTransactionId: refundRes?.data?.refund_id || refundRes?.id || '',
      refundNo: outRefundNo,
      updatedAt: db.serverDate()
    }
  })

  return refundRes.data
}

// ==========================================
// 回复投诉
// ==========================================
async function replyComplaint(complaintId, merchantConfig) {
  const path = `/v3/merchant-service/complaints-v2/${complaintId}/response`
  const body = {
    complainted_mchid: merchantConfig.mchid,
    response_content: '用户您好，非常抱歉给您带来不好的体验，您可在小程序中点击我的-我的订单进行退款申请，本次退款已为您处理，款项将原路返回，请注意查收。如有其他问题，我们随时为您服务，保证让您满意！'
  }

  return await v3Request('POST', path, body, merchantConfig)
}

// ==========================================
// 标记投诉处理完成
// ==========================================
async function completeComplaint(complaintId, merchantConfig) {
  const path = `/v3/merchant-service/complaints-v2/${complaintId}/complete`
  const body = {
    complainted_mchid: merchantConfig.mchid
  }

  return await v3Request('POST', path, body, merchantConfig)
}

// ==========================================
// 投诉回调处理
// ==========================================
async function handleComplaintNotify(event) {
  console.log('[投诉回调] 收到通知:', JSON.stringify(event).substring(0, 500))

  try {
    // 解析 body
    let body = event.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch (e) {
        console.error('[投诉回调] body 解析失败:', e)
        return { statusCode: 400, body: 'invalid body' }
      }
    }

    const { event_type, resource } = body
    if (!resource) {
      console.log('[投诉回调] 缺少 resource')
      return { statusCode: 400, body: 'missing resource' }
    }

    // 解密 resource（和支付回调一样的 AES-GCM）
    const { associated_data, nonce, ciphertext } = resource
    const cipherBuffer = Buffer.from(ciphertext, 'base64')
    const authTag = cipherBuffer.slice(cipherBuffer.length - 16)
    const dataBuffer = cipherBuffer.slice(0, cipherBuffer.length - 16)

    // 需要 apiv3Key 解密 — 从激活商户获取
    let decrypted = null
    let merchantConfig = null

    // 尝试所有商户解密
    const allMerchants = await getAllMerchantConfigs()
    for (const merchant of allMerchants) {
      if (!merchant.apiv3Key) continue
      try {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          Buffer.from(merchant.apiv3Key, 'utf8'),
          Buffer.from(nonce, 'utf8')
        )
        decipher.setAuthTag(authTag)
        decipher.setAAD(Buffer.from(associated_data, 'utf8'))

        decrypted = Buffer.concat([
          decipher.update(dataBuffer),
          decipher.final()
        ]).toString('utf8')

        merchantConfig = merchant
        console.log('[投诉回调] 使用商户解密成功:', merchant.mchid)
        break
      } catch (e) {
        continue
      }
    }

    if (!decrypted) {
      console.error('[投诉回调] 无法解密')
      return { statusCode: 500, body: 'decrypt failed' }
    }

    const notifyData = JSON.parse(decrypted)
    console.log('[投诉回调] 解密数据:', notifyData)

    // 只处理投诉创建/状态变更
    if (!event_type.startsWith('COMPLAINT.')) {
      console.log('[投诉回调] 非投诉事件，忽略:', event_type)
      return { statusCode: 200, body: 'not complaint event' }
    }

    const complaintId = notifyData.complaint_id
    const outTradeNo = notifyData.out_trade_no
    const complaintState = notifyData.complaint_state || ''

    console.log(`[投诉回调] 投诉ID:${complaintId}, 订单:${outTradeNo}, 状态:${complaintState}`)

    // 如果已经处理过，跳过
    if (complaintState === 'COMPLETE' || complaintState === 'REVOKED') {
      console.log('[投诉回调] 投诉已结束，跳过')
      return { statusCode: 200, body: 'already complete' }
    }

    if (!outTradeNo) {
      console.log('[投诉回调] 缺少 out_trade_no')
      return { statusCode: 200, body: 'missing out_trade_no' }
    }

    // 查询本地订单
    let order = null
    try {
      const orderRes = await db.collection('orders').doc(outTradeNo).get()
      order = orderRes.data
    } catch (e) {
      console.warn('[投诉回调] 按ID查询订单失败，尝试字段查询')
    }

    if (!order) {
      const res = await db.collection('orders').where({ outTradeNo: outTradeNo }).limit(1).get()
      if (res.data.length > 0) order = res.data[0]
    }

    if (!order) {
      console.warn('[投诉回调] 未找到订单:', outTradeNo)
      return { statusCode: 200, body: 'order not found' }
    }

    // 检查是否已退款
    if (order.status === ORDER_STATUSES.REFUNDED) {
      console.log('[投诉回调] 订单已退款，直接完成投诉')
      await completeComplaint(complaintId, merchantConfig)
      return { statusCode: 200, body: 'already refunded' }
    }

    // 检查 deposit
    const depositValue = parseFloat(order.deposit) || 0
    if (depositValue <= 0) {
      console.log('[投诉回调] 订单未付款，无需退款')
      // 回复用户
      await replyComplaint(complaintId, merchantConfig)
      await completeComplaint(complaintId, merchantConfig)
      return { statusCode: 200, body: 'no deposit' }
    }

    // 自动退款
    console.log('[投诉回调] 开始自动退款:', order._id)
    await autoRefund(order, merchantConfig)
    console.log('[投诉回调] 退款成功')

    // 回复用户 + 标记完成
    await replyComplaint(complaintId, merchantConfig)
    await completeComplaint(complaintId, merchantConfig)
    console.log('[投诉回调] 投诉处理完成')

    return { statusCode: 200, body: 'success' }
  } catch (err) {
    console.error('[投诉回调] 处理异常:', err)
    // 返回 200 防止微信重试（但记录日志，需要人工排查）
    return { statusCode: 200, body: 'error but ack' }
  }
}

// ==========================================
// 配置投诉回调地址
// ==========================================
async function initNotifyUrl(event) {
  const { notifyUrl, appid } = event
  if (!notifyUrl) {
    return { success: false, errMsg: '请提供回调地址 notifyUrl' }
  }

  // 获取当前小程序 appid（优先用传入的，再尝试从上下文获取）
  let currentAppid = appid
  if (!currentAppid) {
    const wxContext = cloud.getWXContext()
    currentAppid = wxContext.APPID || wxContext.FROM_APPID
  }

  if (!currentAppid) {
    return { success: false, errMsg: '无法获取当前 APPID，请传入 appid 参数' }
  }

  console.log('[initNotifyUrl] 当前 APPID:', currentAppid)

  // 只查询当前 appid 的商户
  let merchants = []
  try {
    const res = await db.collection('merchant_configs')
      .where({ appid: currentAppid })
      .get()
    merchants = res.data || []
  } catch (e) {
    console.error('[initNotifyUrl] 查询商户失败:', e)
    return { success: false, errMsg: '查询商户配置失败' }
  }

  if (merchants.length === 0) {
    return { success: false, errMsg: '未找到当前 appid 对应的商户配置' }
  }

  const results = []

  for (const merchant of merchants) {
    try {
      const path = '/v3/merchant-service/complaint-notifications'
      const body = { url: notifyUrl }

      // 先查询是否已配置过
      let exists = false
      try {
        const queryRes = await v3Request('GET', path, null, merchant)
        console.log(`[initNotifyUrl] 商户 ${merchant.mchid} 查询结果:`, queryRes)
        if (queryRes && queryRes.url) {
          exists = true
        }
      } catch (queryErr) {
        // 查询失败说明没有配置过，继续创建
        console.log(`[initNotifyUrl] 商户 ${merchant.mchid} 尚未配置回调`)
      }

      if (exists) {
        // 已存在，用 PUT 更新
        await v3Request('PUT', path, body, merchant)
        console.log(`[initNotifyUrl] 商户 ${merchant.mchid} 更新成功`)
      } else {
        // 不存在，用 POST 创建
        await v3Request('POST', path, body, merchant)
        console.log(`[initNotifyUrl] 商户 ${merchant.mchid} 创建成功`)
      }

      results.push({ mchid: merchant.mchid, success: true })
    } catch (err) {
      console.error(`[initNotifyUrl] 商户 ${merchant.mchid} 配置失败:`, err.message)
      results.push({ mchid: merchant.mchid, success: false, errMsg: err.message })
    }
  }

  const successCount = results.filter(r => r.success).length
  return {
    success: true,
    message: `配置完成：${successCount}/${results.length} 个商户成功`,
    data: results
  }
}

// ==========================================
// 云函数入口
// ==========================================
exports.main = async (event, context) => {
  console.log('[wxpay-complaint] 收到请求:', JSON.stringify(event).substring(0, 300))

  // HTTP 触发器（投诉回调）
  if (event.httpMethod || (event.headers && event.body !== undefined)) {
    return handleComplaintNotify(event)
  }

  // 云函数调用
  const { action } = event

  if (action === 'initNotifyUrl') {
    return initNotifyUrl(event)
  }

  return { success: false, errMsg: '未知操作' }
}
