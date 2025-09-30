const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const fs = require('fs');
const { Wechatpay } = require('wechatpay-node-v3').default;
// const crypto = require('crypto');

// 常量定义：订单状态和固定费用配置
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

// 工具函数：参数校验
const validateParams = (params, rules) => {
  for (const [key, rule] of Object.entries(rules)) {
    if (params[key] === undefined || params[key] === null) {
      return { valid: false, msg: `参数错误：${key}不能为空` }
    }
    if (rule.type && typeof params[key] !== rule.type) {
      return { 
        valid: false, 
        msg: `参数错误：${key}应为${rule.type}，实际是${typeof params[key]}` 
      }
    }
    if (rule.enum && !rule.enum.includes(params[key])) {
      return { 
        valid: false, 
        msg: `参数错误：${key}必须为${rule.enum.join('或')}` 
      }
    }
  }
  return { valid: true }
}

// 以下配置请使用环境变量或云函数的安全配置
const CONFIG = {
  mchid: process.env.MCHID,
  appid: process.env.APPID,
  notify_url: 'https://cloudbase-3gnr17whd71a5b45-1379469522.ap-shanghai.app.tcloudbase.com/server?action=notify',
  privateKeyPath: './private/apiclient_key.pem',
  merchantSerialNo: process.env.MERCHANT_SERIAL_NO, // 商户证书序列号
  apiv3Key: process.env.WX_API_V3_KEY
};

function getClient() {
  const privateKey = fs.readFileSync(CONFIG.privateKeyPath, 'utf8');
  const client = new Wechatpay({
    appid: CONFIG.appid,
    mchid: CONFIG.mchid,
    serial_no: CONFIG.merchantSerialNo,
    private_key: privateKey,
    apiv3Key: CONFIG.apiv3Key,
  });
  return client;
}

function getPayParams(client, prepayId) {
  // const timeStamp = Math.floor(Date.now() / 1000).toString();
  // const nonceStr = crypto.randomBytes(16).toString('hex');
  const randomBytes = crypto.randomBytes(16);
  console.log('randomBytes:', randomBytes); // 检查是否为undefined
  // const nonceStr = randomBytes.toString('hex');

  return client.getPaySign({
    appid: CONFIG.appid,
    timeStamp,
    nonceStr,
    package: `prepay_id=${prepayId}`
  });
}

function decryptNotify(resource) {
  const { ciphertext, nonce, associated_data } = resource;
  const key = Buffer.from(CONFIG.apiv3Key, 'utf8');
  const dataBuffer = Buffer.from(ciphertext, 'base64');

  const authTag = dataBuffer.slice(dataBuffer.length - 16);
  const encryptedData = dataBuffer.slice(0, dataBuffer.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  if (associated_data) {
    decipher.setAAD(Buffer.from(associated_data, 'utf8'));
  }

  const decoded = decipher.update(encryptedData, undefined, 'utf8') + decipher.final('utf8');
  return JSON.parse(decoded);
}

// async function createPrepayViaSdk({ out_trade_no, openid, amount }) {

//   const privateKey = fs.readFileSync(CONFIG.privateKeyPath, 'utf8');

//   const client = new Wechatpay({
//     mchid: CONFIG.mchid,
//     serial_no: CONFIG.merchantSerialNo,
//     private_key: privateKey,
//     apiv3Key: CONFIG.apiv3Key
//   });

//   // 构造下单请求 body（单位：分）
//   const body = {
//     appid: CONFIG.appid,
//     mchid: CONFIG.mchid,
//     description: '珊星智能存储 - 付款',
//     out_trade_no,
//     notify_url: CONFIG.notify_url,
//     amount: { total: amount, currency: 'CNY' },
//     payer: { openid }
//   };

//   // 调用 JSAPI 下单接口
//   const resp = await client.request('POST', '/v3/pay/transactions/jsapi', body);
//   // resp 中会包含 prepay_id
//   const { prepay_id } = resp;  // 确认返回里有 prepay_id
//   const payParams = client.getPaySign({
//     appid: CONFIG.appid,
//     timeStamp: Math.floor(Date.now() / 1000).toString(),
//     nonceStr: crypto.randomBytes(16).toString('hex'),
//     package: `prepay_id=${prepay_id}`,
//   });
//   return payParams;
// }

exports.main = async (event, context) => {
  const { action } = event
  const now = Date.now()

  // 1. 模拟支付成功
  if (action === 'mockPaySuccess') {
    const { orderId, deviceDeposit} = event
    
    // 参数校验 
    const validation = validateParams(event, {
      orderId: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      return await db.runTransaction(async transaction => {
        return { success: true }
      })
    } catch (err) {
      console.error('模拟支付失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  if (action === 'createPrepay') {
    const { orderId, amount, openid} = event
    
    // 参数校验 
    const validation = validateParams(event, {
      orderId: { type: 'string' },
      openid: { type: 'string' },
      amount: { type: 'number' }
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const client = getClient();

      const body = {
        appid: CONFIG.appid,
        mchid: CONFIG.mchid,
        description: '珊星智能存储 - 付款',
        out_trade_no: orderId,
        notify_url: CONFIG.notify_url,
        amount: { total: amount, currency: 'CNY' },
        payer: { openid }
      };

      const resp = await client.request('POST', '/v3/pay/transactions/jsapi', body);

      if (!resp.prepay_id) {
        throw new Error('下单失败: prepay_id 缺失');
      }
      console.log("getPayParams");
      const payParams = getPayParams(client, resp.prepay_id);

      return { success: true, data: payParams };
    } catch (err) {
      console.error('createPrepay 下单失败', err)
      return { success: false, errMsg: err.message }
    }
  }

  if (action === 'notify') {
    try {
      const bodyStr = typeof event.body === 'string' ? event.body : JSON.stringify(event.body);
      const body = JSON.parse(bodyStr);

      const notifyData = decryptNotify(body.resource);
      console.log('支付结果通知:', notifyData);

      // 更新订单状态
      const orderId = notifyData.out_trade_no;
      const amountFen = notifyData.amount?.total || 0; // 单位：分
      const amountYuan = amountFen / 100;

      await db.collection('orders').doc(orderId).update({
        data: {
          status: CONSTANTS.ORDER_STATUSES.IN_PROGRESS,
          deposit: amountYuan,
          updatedAt: db.serverDate()
        }
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ code: 'SUCCESS', message: '成功' })
      };
    } catch (err) {
      console.error('notify 处理失败', err);
      return {
        statusCode: 500,
        body: JSON.stringify({ code: 'FAIL', message: err.message })
      };
    }
  }

  // 2. 创建订单
  if (action === 'createOrder') {
    const {password, lockerInfo, userInfo} = event

    const validation = validateParams(event, {
      password: {type: 'string'},
    })
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    try {
      return await db.runTransaction(async transaction => {

        // 构建订单数据
        const order = {
          password: password,
          lockerId: lockerInfo._id,
          deviceId: lockerInfo.deviceId,
          internalNo: lockerInfo.internalNo,
          cabinetNo: lockerInfo.cabinetNo,
          doorNo: lockerInfo.doorNo,
          lockerNo: lockerInfo.lockerNo,
          deviceAddress: lockerInfo.deviceAddress,
          userId: userInfo._id,
          openid: userInfo.openid,
          phone: userInfo.phone,
          status: CONSTANTS.ORDER_STATUSES.PENDING_PAY,
          deposit: 0,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
        // 创建订单
        const addRes = await transaction.collection('orders').add({ data: order })

        return { success:true, data: addRes._id }
      })
    } catch (err) {
      console.error('创建订单失败', { error: err.message})
      return { success:false, errMsg: err.message }
    }
  }

  // 3. 获取单个订单详情
  if (action === 'getOrder') {
    const { orderId } = event
    
    // 参数校验
    const validation = validateParams(event, {
      orderId: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }
  
    try {
      const doc = await db.collection('orders').doc(orderId).get()
      if (!doc.data) {
        throw new Error('订单不存在');
      }
      return { success: true, data: doc.data }
    } catch (err) {
      console.error('获取订单详情失败', { orderId: id, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 4. 更新订单信息
  if (action === 'updateOrder') {
    const { orderId, status, deposit} = event
    
    // 参数校验
    const validation = validateParams(event, {
      orderId: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      return await db.runTransaction(async transaction => {
        // 获取订单
        const orderDoc = await transaction.collection('orders').doc(orderId).get()
        if (!orderDoc.data) {
          throw new Error('订单不存在')
        }
  
        // 更新数据
        const updateData = { updatedAt: db.serverDate() }
        if (typeof status !== 'undefined') {
          updateData.status = status
        }
        if (typeof deposit !== 'undefined') {
          updateData.deposit = deposit
        }
  
        // 更新订单
        await transaction.collection('orders').doc(orderId).update({
          data: updateData
        })
  
        return { success: true , message: '更新订单信息成功'}
      })
    } catch (err) {
      console.error('更新订单信息失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 4. 完成订单
  if (action === 'finishOrder') {
    const { orderId } = event
    
    // 参数校验
    const validation = validateParams(event, {
      orderId: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }
    
    try {
      return await db.runTransaction(async transaction => {
        // 获取订单
        const orderDoc = await transaction.collection('orders').doc(orderId).get()

        if (!orderDoc.data) {
          throw new Error('订单不存在')
        }
        
        // 验证订单状态
        if (orderDoc.data.status !== CONSTANTS.ORDER_STATUSES.IN_PROGRESS) {
          throw new Error(`订单状态不可完成，当前状态：${orderDoc.data.status}`)
        }

        // 更新订单状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.COMPLETED,
            endTime: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })

        return { 
          success: true, message: "订单已完成"
        }
      })
    } catch (err) {
      console.error('完成订单失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 5. 强制结束订单（管理员用）
  if (action === 'forceFinish') {
    const { orderId } = event
    
    // 参数校验
    const validation = validateParams(event, {
      orderId: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      return await db.runTransaction(async transaction => {
        // 获取订单
        const orderDoc = await transaction.collection('orders').doc(orderId).get()
        if (!orderDoc.data) {
          throw new Error('订单不存在')
        }

        // 更新订单状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.FORCE_FINISHED,
            endTime: db.serverDate(),
            updatedAt: db.serverDate()
          }
        })

        // 释放柜子
        if (orderDoc.data.lockerId) {
          await transaction.collection('lockers').doc(orderDoc.data.lockerId).update({
            data: {
              status: 'free',
              currentOrderId: null,
              updatedAt: db.serverDate()
            }
          })
        }

        return { success: true }
      })
    } catch (err) {
      console.error('强制结束订单失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 7. 通过openid查询订单
  if (action === 'queryByOpenid') {
    const {openid, deviceId} = event;
    // 参数校验
    const validation = validateParams(event, {
      openid: { type: 'string' },
      deviceId: { type: 'string' }
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const orderInfo = await db.collection('orders')
        .where({
          openid,
          deviceId,
          status: _.in(CONSTANTS.VALID_STATUSES_FOR_QUERY)
        })
        .field({
          _id: true,
          deviceId: true,
          cabinetNo: true,
          doorNo: true,
          lockerNo: true,
          status: true,
          lockerId: true,
          createdAt: true
        })
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get()

        if (orderInfo.data.length === 0) {
          throw new Error('无openid&deviceId相关订单');
        }

        const order = orderInfo.data[0];
        console.log(`匹配到订单：ID=${order._id}，柜门=${order.doorNo}`)
        return { success: true, data: order }
     
    } catch (err) {
      console.error('查询订单失败', {error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 8. 根据手机号查询订单
  if (action === 'getCurrentUser') {
    const { orderId } = event;
    
    // 参数校验
    const validation = validateParams(event, {
      orderId: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const doc = await db.collection('orders').doc(orderId).get()
      if (doc.data) {
        return { success: true, data: doc.data }
      } else {
        return { success: false, errMsg: '订单不存在' }
      }
    } catch (err) {
      console.error('查询订单失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  if (action === 'recoverOrder') {
    const { orderId, targetStatus } = event;
  
    // 参数校验
    const validation = validateParams(event, {
      orderId: { type: 'string' },
      targetStatus: { type: 'string' }
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    const allowedStatus = ['已取消'];
    if (!allowedStatus.includes(targetStatus)) {
      return { success: false, errMsg: `参数错误：targetStatus允许值为${allowedStatus.join(',')}` };
    }

    try {
      // 1. 查询订单当前状态
      return await db.runTransaction(async transaction => {

        const orderRes = await transaction.collection('orders').doc(orderId).get();
        if (!orderRes.data) {
          throw new Error(`订单 ${orderId} 不存在`);
        }
        const order = orderRes.data;
    
        // 2. 验证是否需要恢复（仅对异常状态的订单操作）
        const abnormalStatuses = ['进行中', '待支付']; 
        if (!abnormalStatuses.includes(order.status)) {
          throw new Error('订单当前状态为${order.status}，无需恢复');
        }
    
        // 3. 更新订单状态为目标状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: targetStatus,
            recoverAt: db.serverDate(), // 记录恢复时间
            updatedAt: db.serverDate()
          }
        });
    
        return { 
          success: true, 
          message: `订单 ${orderId} 已从${order.status}恢复为${targetStatus}`
        };
      })
    } catch (err) {
      console.error(`恢复订单 ${orderId} 失败`, err);
      return { success: false, errMsg: `恢复订单失败：${err.message}` };
    }
  }

  if (action === 'getUserOrders') {
    const {openid} = event;
    // 参数校验
    const validation = validateParams(event, {
      openid: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const orderInfo = await db.collection('orders')
        .where({
          openid,
        })
        .field({
          _id: true,
          phone: true,
          password: true,
          internalNo: true,
          lockerNo: true,
          deviceAddress: true,
          status: true,
          openid: true,
          createdAt: true
        })
        .get()

        if (orderInfo.data.length === 0) {
          throw new Error('无用户相关订单');
        }

        const order = orderInfo.data;
        console.log(`匹配到订单：ID=${order._id}`)
        return { success: true, data: order }
     
    } catch (err) {
      console.error('查询用户所有订单失败', {error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}
