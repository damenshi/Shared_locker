const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const fs = require('fs');
const Pay = require('wechatpay-node-v3');
const crypto = require('crypto');

// 常量定义：订单状态
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
  notify_url: 'https://cloudbase-3gnr17whd71a5b45-1379469522.ap-shanghai.app.tcloudbase.com/paynotify',
  privateKeyPath: './private/apiclient_key.pem',
  wechatPayPublicKeyPath: './private/pub_key.pem',
  publicKeyPath: './private/apiclient_cert.pem',
  merchantSerialNo: process.env.MERCHANT_SERIAL_NO, // 商户证书序列号
  apiv3Key: process.env.WX_API_V3_KEY
};

function getClient() {
  try {    
    // 1. 读取商户私钥
    const privateKey = fs.readFileSync(CONFIG.privateKeyPath, 'utf8');
    const wechatPayPublicKey = fs.readFileSync(CONFIG.wechatPayPublicKeyPath, 'utf8');
    const publicKey = fs.readFileSync(CONFIG.publicKeyPath, 'utf8');

    if (!privateKey) {
      throw new Error('商户私钥读取失败');
    }

    // 2. 初始化客户端
    const client = new Pay({
      mchid: CONFIG.mchid,
      appid: CONFIG.appid,
      serial_no: CONFIG.merchantSerialNo, // 商户证书序列号
      publicKey: publicKey,
      privateKey: privateKey      // 商户私钥
    });

    return client;

  } catch (err) {
    console.error('初始化支付客户端失败:', err);
    throw err; // 抛出错误让上层处理
  }
}

function getPayParams(prepayId) {
  const privateKey = fs.readFileSync(CONFIG.privateKeyPath, 'utf8');
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');

  const payParams = {
    appId: CONFIG.appid,
    timeStamp,
    nonceStr,
    package: `prepay_id=${prepayId}`,
    signType: 'RSA'
  };

  // 使用商户私钥生成 paySign
  const message = `${payParams.appId}\n${payParams.timeStamp}\n${payParams.nonceStr}\n${payParams.package}\n`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  payParams.paySign = sign.sign(privateKey, 'base64');

  return payParams;
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


exports.main = async (event, context) => {
  const { action } = event
  const now = Date.now()

  if (action === 'createPrepay') {
    const { orderId, amount, openid } = event

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
      const client = await getClient();

      const orderParams = {
        mchid: CONFIG.mchid,
        out_trade_no: orderId,
        description: '珊星智能存储 - 付款',
        notify_url: CONFIG.notify_url,
        amount: { total: amount, currency: 'CNY' },
        payer: { openid }
      };

      const resp = await client.transactions_jsapi(orderParams);
      console.log('JSAPI下单返回:', resp);
      const prepayId = resp.data.package.split('=')[1]; // 从 package 字符串里解析
      if (!prepayId) {
        throw new Error('下单失败: prepay_id 缺失');
      }
      console.log("getPayParams");
      const payParams = getPayParams(prepayId);

      return { success: true, data: payParams };
    } catch (err) {
      console.error('createPrepay 下单失败', err)
      return { success: false, errMsg: err.message }
    }
  }

  // 2. 创建订单
  if (action === 'createOrder') {
    const { password, lockerInfo, userInfo } = event

    const validation = validateParams(event, {
      password: { type: 'string' },
    })
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    try {
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
          transactionId: '',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
        // 创建订单
        const addRes = await db.collection('orders').add({ data: order })

        return { success: true, data: addRes._id }
    } catch (err) {
      console.error('创建订单失败', { error: err.message })
      return { success: false, errMsg: err.message }
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
    const { orderId, status, deposit } = event

    // 参数校验
    const validation = validateParams(event, {
      orderId: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const updateData = { updatedAt: db.serverDate() };
      if (typeof status !== 'undefined') updateData.status = status;
      if (typeof deposit !== 'undefined') updateData.deposit = deposit;

      const res = await db.collection('orders')
        .doc(orderId)
        .update({ data: updateData });

      if (res.stats.updated === 0) {
        return { success: false, errMsg: '订单不存在或未更新' };
      }

      return { success: true, message: '更新订单信息成功' };
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
    const { openid, deviceId } = event;
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
          status: true,
          deviceId: true,
          doorNo: true,
          orderId: true,
          cabinetNo: true,
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
      console.error('查询订单失败', { error: err.message })
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
    const { openid } = event;
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
          createdAt: true,
          deposit: true
        })
        .get()

      if (orderInfo.data.length === 0) {
        throw new Error('无用户相关订单');
      }

      const order = orderInfo.data;
      console.log(`匹配到订单：ID=${order._id}`)
      return { success: true, data: order }

    } catch (err) {
      console.error('查询用户所有订单失败', { error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  if (action === 'getUserOrdersByPhone') {
    const { phone } = event;
    // 参数校验
    const validation = validateParams(event, {
      phone: { type: 'string' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const orderInfo = await db.collection('orders')
        .where({
          phone,
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
          createdAt: true,
          deposit: true
        })
        .get()

      if (orderInfo.data.length === 0) {
        throw new Error('无用户相关订单');
      }

      const order = orderInfo.data;
      console.log(`匹配到订单：ID=${order._id}`)
      return { success: true, data: order }

    } catch (err) {
      console.error('通过手机查询用户所有订单失败', { error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  if (action === 'refundOrder') {
    const { openid, orderId } = event
    const orderDoc = await db.collection('orders').doc(orderId).get()
    const order = orderDoc.data

    try {
      if (![
        CONSTANTS.ORDER_STATUSES.COMPLETED, 
        CONSTANTS.ORDER_STATUSES.CANCELLED
      ].includes(order.status)) {
        throw new Error(`仅【已完成】或【已取消】订单可退款\n当前状态：【${order.status}】`);
      }

      const client = await getClient();
      const refundParams = {
        out_trade_no: order.outTradeNo || order._id,
        transaction_id: order.transactionId,
        out_refund_no: `refund_${Date.now()}`,
        amount: {
          refund: order.deposit * 100,
          total: order.deposit * 100,
          currency: 'CNY'
        },
        notify_url: CONFIG.notify_url
      };

      const refundRes = await client.refunds(refundParams);
      console.log('退款结果：', refundRes)

      await db.runTransaction(async (transaction) => {
        await transaction.collection('users')
          .where({ openid })
          .update({
            data: {
              deposit: _.inc(-order.deposit),
              updatedAt: db.serverDate()
            }
          });

        await transaction.collection('orders').doc(orderId)
          .update({
            data: {
              status: CONSTANTS.ORDER_STATUSES.REFUNDED,
              refundTime: new Date(),
              refundTransactionId: refundRes.id
            }
          });
      });

      return { success: true, data: refundRes };
    } catch (err) {
      console.log('退款失败：', err)
      return { success: false, errMsg: err.message }
    }
  }

  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}
