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

  console.log(`[回调] 订单 ${orderId} 支付成功，准备处理...`);

  // 1. 查询订单
  const orderRes = await db.collection('orders').doc(orderId).get();
  const order = orderRes.data;

  // 拦截终态
  if ([CONSTANTS.ORDER_STATUSES.CANCELLED, 
       CONSTANTS.ORDER_STATUSES.COMPLETED, 
       CONSTANTS.ORDER_STATUSES.REFUNDED].includes(order.status)) {
    console.log(`[回调] 订单 ${orderId} 处于终态，跳过`);
    return;
  }
  
  // 拦截进行中
  if (order.status === CONSTANTS.ORDER_STATUSES.IN_PROGRESS) {
    console.log(`[回调] 订单 ${orderId} 已是进行中，跳过`);
    return;
  }

  // 定义一个变量来标记最终决定：是“通过”还是“取消”
  let isPassed = false;
  let failReason = '';

  try {
    // 2. 尝试开门
    console.log(`[回调] 尝试开门: ${orderId}`);
    const lockerRes = await cloud.callFunction({
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

    // === 核心逻辑分支 ===
    if (lockerRes.result.success) {
      // 场景A：明确成功
      isPassed = true;
      console.log(`[回调] 开门成功`);
    } else {
      // 场景B：开门报错，分析错误原因
      const errMsg = lockerRes.result.errMsg || '';
      console.error(`[回调] 开门返回失败: ${errMsg}`);

      //关键判断：只有服务器明确返回 500 时，才认定为硬伤
      // 匹配 openDoor 中的 throw Error(`服务器返回错误: ${err.response.status} ...`)
      if (errMsg.includes('服务器返回错误: 500')) {
         isPassed = false;
         failReason = errMsg; // 记录原因，准备取消订单
      } else {
         // 其他所有情况（超时、网络波动、404、未知错误等），一律视为“软错误”
         // 策略：疑罪从无，认为是成功的（防止白嫖）
         isPassed = true;
         console.warn(`[回调] 捕获软错误(${errMsg})，降级处理为【成功】`);
      }
    }

  } catch (err) {
    // 场景C：调用云函数本身崩了（极少见）
    // 同样视为软错误，防止白嫖
    console.error(`[回调] 云函数调用异常:`, err);
    isPassed = true; 
  }

  // === 3. 根据最终决定执行数据库更新 ===
  if (isPassed) {
    //成功（或软错误强制成功） -> 进行中
    await db.collection('orders').doc(orderId).update({
      data: {
        status: CONSTANTS.ORDER_STATUSES.IN_PROGRESS,
        transactionId: transactionId,
        deposit: amountYuan,
        payTime: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    console.log(`[回调] 订单 ${orderId} 已设为【进行中】`);
  } else {
    //失败（明确的 500 硬伤） -> 取消订单 + 释放柜子
    console.warn(`[回调] 订单 ${orderId} 判定为硬伤(${failReason})，执行取消`);
    await db.collection('orders').doc(orderId).update({
      data: {
        status: CONSTANTS.ORDER_STATUSES.CANCELLED,
        transactionId: transactionId,               
        deposit: amountYuan,                        
        refundAmount: amountYuan,
        payTime: db.serverDate(),
        updatedAt: db.serverDate(),
        note: `自动取消：${failReason}`
      }
    });

    try {
      await cloud.callFunction({
        name: 'locker',
        data: {
          action: 'recoverLocker',
          deviceId: order.deviceId,
          doorNo: order.doorNo,
          cabinetNo: order.cabinetNo
        }
      });
      console.log(`[回调] 柜子 ${order.cabinetNo}-${order.doorNo} 已释放`);
    } catch (e) {
      console.error(`[回调] 释放柜子失败（需人工介入）:`, e);
    }
  }
}

async function handleRefundNotify(notifyData) {
  const outRefundNo = notifyData.out_refund_no; // 微信传回的退款单号
  const outTradeNo = notifyData.out_trade_no;   // 微信传回的商户订单号 (对应你的 _id)
  const refundId = notifyData.refund_id;        // 微信生成的退款流水号
  const refundAmountFen = notifyData.amount?.refund || 0;
  const refundAmountYuan = refundAmountFen / 100;

  console.log(`[退款回调] 开始处理，退款单号:${outRefundNo}, 订单号(ID):${outTradeNo}`);

  let order = null;

  // === 策略1：优先用 _id (out_trade_no) 直接查 ===
  try {
    const doc = await db.collection('orders').doc(outTradeNo).get();
    order = doc.data;
  } catch (e) {
    // 如果ID格式不对或找不到，doc()会抛错，这里捕获它
    console.warn(`[退款回调] 按ID查询失败，尝试字段查询`);
  }

  // === 策略2：如果按ID没查到，尝试按 outTradeNo 字段查 ===
  // (防止有些订单用了自定义的 outTradeNo 而不是 _id)
  if (!order) {
    const res = await db.collection('orders').where({ outTradeNo: outTradeNo }).limit(1).get();
    if (res.data.length > 0) order = res.data[0];
  }

  // === 策略3：最后尝试按 refundNo 查 (兼容以后修复后的新数据) ===
  if (!order) {
    const res = await db.collection('orders').where({ refundNo: outRefundNo }).limit(1).get();
    if (res.data.length > 0) order = res.data[0];
  }

  // === 关键修复：如果还是找不到，必须 return，不能抛 Error ===
  if (!order) {
    console.warn(`[退款回调-跳过] 数据库未找到订单，可能是测试数据或脏数据。停止重试。`);
    // 直接返回成功，骗过微信，停止重试
    return; 
  }

  const orderId = order._id;
  
  // 检查状态，防止重复处理
  if (order.status === CONSTANTS.ORDER_STATUSES.REFUNDED) {
    console.log(`[退款回调] 订单 ${orderId} 已经是退款状态，跳过`);
    return;
  }

  // === 更新数据库 ===
  // 顺便把缺失的 refundNo 补进去
  const updateData = {
    status: CONSTANTS.ORDER_STATUSES.REFUNDED,
    refundId: refundId,          
    refundNo: outRefundNo,       // 补全这个字段！
    refundAmount: refundAmountYuan,
    updatedAt: db.serverDate()
  };

  await db.collection('orders').doc(orderId).update({ data: updateData });
  console.log(`[退款回调] 订单 ${orderId} 退款状态更新成功`);
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