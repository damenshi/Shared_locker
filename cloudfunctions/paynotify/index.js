const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const crypto = require('crypto');

const CONSTANTS = {
  ORDER_STATUSES: {
    PENDING_PAY: '待支付',
    IN_PROGRESS: '进行中',
    COMPLETED: '已完成',
    FORCE_FINISHED: '已强制结束',
    CANCELLED: '已取消'
  },
  VALID_STATUSES_FOR_QUERY: ['进行中']
}

const CONFIG = {
  apiv3Key: process.env.WX_API_V3_KEY
};

// 解密回调报文
function decryptNotify(resource) {
  const { associated_data, nonce, ciphertext } = resource

  // 1. Base64 解码 ciphertext
  const cipherBuffer = Buffer.from(ciphertext, 'base64')

  // 2. 分离 authTag（最后16字节）和真实密文
  const authTag = cipherBuffer.slice(cipherBuffer.length - 16)
  const dataBuffer = cipherBuffer.slice(0, cipherBuffer.length - 16)

  // 3. 创建 decipher
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(CONFIG.apiv3Key, 'utf8'), // 确保是 Buffer
    Buffer.from(nonce, 'utf8')
  )
  decipher.setAuthTag(authTag)
  decipher.setAAD(Buffer.from(associated_data, 'utf8'))

  // 4. 解密
  const decrypted = Buffer.concat([
    decipher.update(dataBuffer),
    decipher.final()
  ])
  return JSON.parse(decrypted.toString('utf8'))
}

// 云函数入口
exports.main = async (event) => {
  console.log('收到支付回调:', event)

  if (!event.headers || !event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ code: 'FAIL', message: '缺少必要参数' })
    }
  }

  // Step1: 解析 body
  let body
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body
  } catch (err) {
    console.error('解析回调 body 失败:', err)
    return {
      statusCode: 400,
      body: JSON.stringify({ code: 'FAIL', message: 'body 非 JSON 格式' })
    }
  }

  if (!body.resource) {
    return {
      statusCode: 400,
      body: JSON.stringify({ code: 'FAIL', message: '缺少 resource 字段' })
    }
  }

  try {
    // Step2: 解密通知数据
    const notifyData = decryptNotify(body.resource)
    console.log('支付结果通知解密后数据:', notifyData)

    const orderId = notifyData.out_trade_no
    const amountFen = notifyData.amount?.total || 0
    const amountYuan = amountFen / 100

    // Step3: 更新订单状态
    await db.collection('orders').doc(orderId).update({
      data: {
        status: CONSTANTS.ORDER_STATUSES.IN_PROGRESS,
        deposit: amountYuan,
        updatedAt: db.serverDate()
      }
    })

    // Step4: 返回成功
    return {
      statusCode: 200,
      body: JSON.stringify({ code: 'SUCCESS', message: '成功' })
    }
  } catch (err) {
    console.error('支付回调处理失败:', err)
    return {
      statusCode: 500,
      body: JSON.stringify({ code: 'FAIL', message: err.message })
    }
  }
}