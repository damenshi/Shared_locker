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
    CANCELLED: '已取消',
    REFUNDED: '已退款'
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

async function handlePayNotify(notifyData) {
  const orderId = notifyData.out_trade_no;
  const transactionId = notifyData.transaction_id;
  const amountFen = notifyData.amount?.total || 0;
  const amountYuan = amountFen / 100;

  console.log(`[回调] 订单 ${orderId} 支付成功，准备开门...`);

  // 1. 先查询订单信息获取柜门号 (新增)
  const orderRes = await db.collection('orders').doc(orderId).get();
  const order = orderRes.data;

  // 2. 调用 locker 云函数执行开门 (新增核心逻辑)
  // 哪怕这里开门报错，也不能阻塞更新订单状态，否则微信会一直重试
  try {
    // 只有当订单状态不是进行中时才开门，防止微信重复回调导致重复开门
    if (order.status !== CONSTANTS.ORDER_STATUSES.IN_PROGRESS) {
       await cloud.callFunction({
        name: 'locker',
        data: {
          action: 'openDoor',
          deviceId: order.deviceId,
          doorNo: order.doorNo,
          cabinetNo: order.cabinetNo,
          orderId: orderId,
          type: 'store'
        }
      });
      console.log(`[回调] 柜门 ${order.lockerNo} 开门指令发送成功`);
    }
  } catch (err) {
    console.error(`[回调] 开门失败 (可能是硬件离线或已开):`, err);
    // 这里不抛出错误，继续向下执行更新订单状态，保证支付流程完整
  }

  // 3. 更新数据库状态 (原逻辑)
  await db.collection('orders').doc(orderId).update({
    data: {
      status: CONSTANTS.ORDER_STATUSES.IN_PROGRESS,
      transactionId: transactionId,
      deposit: amountYuan,
      payTime: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
}

async function handleRefundNotify(notifyData) {
  const outRefundNo = notifyData.out_refund_no;
  const refundId = notifyData.refund_id;
  const refundAmountFen = notifyData.amount?.refund || 0;
  const refundAmountYuan = refundAmountFen / 100;

  const orderRes = await db.collection('orders')
    .where({ refundNo: outRefundNo })
    .limit(1)
    .get();

  if (orderRes.data.length === 0) {
    throw new Error(`未找到退款单号为 ${outRefundNo} 的订单`);
  }
  const order = orderRes.data[0];
  const orderId = order._id;

  const updateData = {
    status: CONSTANTS.ORDER_STATUSES.REFUNDED,
    refundId: refundId,
    refundAmount: refundAmountYuan,
    updatedAt: db.serverDate()
  };

  await db.collection('orders').doc(orderId).update({ data: updateData });
}

// 云函数入口
exports.main = async (event) => {
  console.log('收到支付/退款回调:', event)

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
    console.log('通知解密后数据:', notifyData)
    const eventType = body.event_type;

    if (eventType === "REFUND.SUCCESS" || eventType === "REFUND.FAIL") {
      console.log('处理退款回调，退款单号:', notifyData.out_refund_no);
      await handleRefundNotify(notifyData);
    } else if (eventType === 'TRANSACTION.SUCCESS') {
      console.log('处理支付回调，订单号:', notifyData.out_trade_no);
      await handlePayNotify(notifyData);
    } else {
      throw new Error('无法识别的通知类型');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ code: 'SUCCESS', message: '成功' })
    }
  } catch (err) {
    console.error('回调处理失败:', err)
    return {
      statusCode: 500,
      body: JSON.stringify({ code: 'FAIL', message: err.message })
    }
  }
}