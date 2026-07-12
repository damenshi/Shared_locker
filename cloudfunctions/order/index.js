const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const fs = require('fs');
const Pay = require('wechatpay-node-v3');
const crypto = require('crypto');
const { getActiveMerchant, getMiniName, getOrderDescription } = require('./utils/config');

// 常量定义：订单状态
const CONSTANTS = {
  ORDER_STATUSES: {
    PENDING_PAY: '待支付',
    IN_PROGRESS: '进行中',
    COMPLETED: '已完成',
    FORCE_FINISHED: '已强制结束',
    CANCELLED: '已取消',
    CLOSED: '已关闭',           // 新增：已付款但开门失败
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

// ==========================================
// 商户配置获取函数
// ==========================================

// 获取当前激活的商户配置
async function getActiveMerchantConfig() {
  try {
    const res = await db.collection('merchant_configs')
      .where({ isActive: true })
      .limit(1)
      .get();
    if (res.data.length === 0) {
      // 返回 null，让调用方使用默认 CONFIG
      return null;
    }
    return res.data[0];
  } catch (e) {
    console.error('获取激活商户配置失败:', e);
    return null;
  }
}

// 根据 appid 获取激活的商户配置
async function getMerchantConfigByAppid(appid) {
  if (!appid) {
    return await getActiveMerchantConfig();
  }
  try {
    const res = await db.collection('merchant_configs')
      .where({ appid: appid, isActive: true })
      .limit(1)
      .get();
    if (res.data.length === 0) {
      // 如果该 appid 没有激活的商户，兜底使用全局激活的商户
      console.log(`[getMerchantConfigByAppid] appid=${appid} 没有激活商户，兜底使用全局激活商户`);
      return await getActiveMerchantConfig();
    }
    return res.data[0];
  } catch (e) {
    console.error('获取商户配置失败:', e);
    return await getActiveMerchantConfig();
  }
}

// 根据商户ID获取配置
async function getMerchantConfigById(merchantId) {
  if (!merchantId) {
    console.error('商户ID不能为空');
    return null;
  }

  try {
    const res = await db.collection('merchant_configs')
      .doc(merchantId)
      .get();
    return res.data && Object.keys(res.data).length > 0 ? res.data : null;
  } catch (e) {
    console.error('获取商户配置失败:', e);
    return null;
  }
}

// 获取所有商户配置
async function getAllMerchantConfigs() {
  try {
    const res = await db.collection('merchant_configs')
      .orderBy('order', 'asc')
      .get();
    return res.data;
  } catch (e) {
    console.error('获取所有商户配置失败:', e);
    return [];
  }
}

// 获取商户支付客户端
async function getClient(merchantConfig) {
  try {
    // 如果没有传入配置，获取当前激活的
    const config = merchantConfig || await getActiveMerchantConfig();

    if (!config) {
      throw new Error('未找到商户配置，请先配置商户信息');
    }

    // 使用数据库配置，如果数据库中没有证书内容则从文件读取
    const privateKey = config.privateKey || fs.readFileSync('./private/apiclient_key.pem', 'utf8');
    const publicKey = config.publicCert || fs.readFileSync('./private/apiclient_cert.pem', 'utf8');

    return new Pay({
      mchid: config.mchid,
      appid: config.appid,
      serial_no: config.merchantSerialNo,
      publicKey: publicKey,
      privateKey: privateKey
    });

  } catch (err) {
    console.error('初始化支付客户端失败:', err);
    throw err;
  }
}

async function getPayParams(prepayId, merchantConfig) {
  const config = merchantConfig || await getActiveMerchantConfig();
  if (!config) {
    throw new Error('未找到商户配置');
  }

  const privateKey = config.privateKey || fs.readFileSync('./private/apiclient_key.pem', 'utf8');
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');

  const payParams = {
    appId: config.appid,
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

async function decryptNotify(resource, apiv3Key) {
  const { ciphertext, nonce, associated_data } = resource;
  const key = Buffer.from(apiv3Key, 'utf8');
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

async function calculateFee(order) {
  const now = Date.now();

  const startTime = new Date(order.createdAt).getTime(); 
  
  const durationMs = now - startTime;
  const durationMinutes = Math.ceil(durationMs / 1000 / 60); // 分钟
  const durationHours = Math.ceil(durationMinutes / 60);       // 小时

  let fee = 0; // 单位：分
  let unitPrice = 0; // 默认价格（0元/小时)
  try {
    const devRes = await db.collection('devices')
      .where({ deviceId: order.deviceId })
      .get();
      
    if (devRes.data.length > 0) {
      const device = devRes.data[0];
      unitPrice = device.unitPrice !== undefined ? device.unitPrice : (device.unitPrice || 0);
      isFree = device.isFree || false;
    }
  } catch (err) {
    console.error('获取设备价格失败，使用默认价格', err);
  }

  //优先判断是否免费
  if (isFree) {
    fee = 0; // 免费模式下，无论时长多久，费用恒为 0
    console.log(`[calculateFee] 设备 ${order.deviceId} 处于免费模式，不计费`);
  } else {
    // 计费规则：免费时长10分钟
    const FREE_MINUTES = 10;
    if (durationMinutes > FREE_MINUTES) {
      fee = durationHours * unitPrice * 100;
    }
  }

  // 押金转为分
  const depositInCents = Math.round(order.deposit * 100); 

  // 费用不能超过押金
  if (fee > depositInCents) {
    fee = depositInCents;
  }

  const refundAmount = depositInCents - fee; // 应退金额

  console.log(`[calculateFee] 结算: 单价${unitPrice}, 分钟${durationMinutes}, 小时${durationHours}, 费用${fee}`);

  return {
    durationMinutes,
    durationHours,
    fee,            // 实收费用 (分)
    refundAmount,   // 应退金额 (分)
    depositInCents, // 原押金 (分)
    unitPrice
  };
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
      // 先查询订单，获取设备的 appid
      let deviceAppid = '';
      const orderRes = await db.collection('orders').where({ _id: orderId }).get();
      if (orderRes.data.length > 0 && orderRes.data[0].appid) {
        deviceAppid = orderRes.data[0].appid;
      }

      // 根据设备 appid 获取对应的商户配置
      let activeMerchant;
      try {
        activeMerchant = await getMerchantConfigByAppid(deviceAppid);
      } catch (e) {
        console.error('获取商户配置失败，使用默认配置');
      }

      // 获取支付客户端
      const client = await getClient(activeMerchant);

      // 使用对应商户的配置
      const merchantConfig = activeMerchant;
      if (!merchantConfig) {
        return { success: false, errMsg: '未找到商户配置' };
      }

      // 动态获取小程序名称
      const orderDesc = await getOrderDescription();

      const orderParams = {
        appid: merchantConfig.appid,
        mchid: merchantConfig.mchid,
        out_trade_no: orderId,
        description: orderDesc,
        notify_url: merchantConfig.notify_url,
        amount: { total: amount, currency: 'CNY' },
        payer: { openid }
      };

      const resp = await client.transactions_jsapi(orderParams);
      console.log('JSAPI下单返回:', resp);
      const prepayId = resp.data.package.split('=')[1]; // 从 package 字符串里解析
      if (!prepayId) {
        throw new Error('下单失败: prepay_id 缺失');
      }

      // 直接生成支付签名参数，使用对应商户的私钥
      const privateKey = merchantConfig.privateKey || fs.readFileSync('./private/apiclient_key.pem', 'utf8');
      const timeStamp = Math.floor(Date.now() / 1000).toString();
      const nonceStr = crypto.randomBytes(16).toString('hex');
      const packageStr = `prepay_id=${prepayId}`;

      const payParams = {
        appId: merchantConfig.appid,
        timeStamp,
        nonceStr,
        package: packageStr,
        signType: 'RSA'
      };

      // 使用商户私钥生成 paySign
      const message = `${payParams.appId}\n${payParams.timeStamp}\n${payParams.nonceStr}\n${payParams.package}\n`;
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(message);
      payParams.paySign = sign.sign(privateKey, 'base64');

      return { success: true, data: payParams };
    } catch (err) {
      console.error('createPrepay 下单失败', err)
      return { success: false, errMsg: err.message }
    }
  }

  // 2. 创建订单
  // if (action === 'createOrder') {
  //   const { password, lockerInfo, userInfo } = event

  //   const validation = validateParams(event, {
  //     password: { type: 'string' },
  //   })
  //   if (!validation.valid) {
  //     return { ok: false, errMsg: validation.msg }
  //   }

  //   try {
  //       // 构建订单数据
  //       const order = {
  //         password: password,
  //         lockerId: lockerInfo._id,
  //         deviceId: lockerInfo.deviceId,
  //         internalNo: lockerInfo.internalNo,
  //         cabinetNo: lockerInfo.cabinetNo,
  //         doorNo: lockerInfo.doorNo,
  //         lockerNo: lockerInfo.lockerNo,
  //         deviceAddress: lockerInfo.deviceAddress,
  //         userId: userInfo._id,
  //         openid: userInfo.openid,
  //         phone: userInfo.phone,
  //         status: CONSTANTS.ORDER_STATUSES.PENDING_PAY,
  //         deposit: 0,
  //         transactionId: '',
  //         createdAt: db.serverDate(),
  //         updatedAt: db.serverDate()
  //       }
  //       // 创建订单
  //       const addRes = await db.collection('orders').add({ data: order })

  //       return { success: true, data: addRes._id }
  //   } catch (err) {
  //     console.error('创建订单失败', { error: err.message })
  //     return { success: false, errMsg: err.message }
  //   }
  // }

  // 2. 创建订单（已重构：原子锁柜 + 自动重试 + 创单合并）
  if (action === 'createOrder') {
    const { password, deviceId, userInfo } = event

    // 基础参数校验
    const validation = validateParams(event, {
      password: { type: 'string' },
      deviceId: { type: 'string' }
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      // ==========================================
      // 🛑 1. 拦截从设备存包请求（补回来的核心逻辑）
      // ==========================================
      const devRes = await db.collection('devices').where({ deviceId }).get();
      if (devRes.data.length > 0) {
        const device = devRes.data[0];
        // 如果存在 masterId，说明这是取包面（从设备）
        if (device.masterId) {
           return { 
             success: false, 
             errMsg: '此处为取包口，请前往柜子正面（存包区）进行存包' 
           };
        }
      }

      // ==========================================
      // 【被动清理】释放本设备上超时(>5分钟)未支付的遗留订单
      // ==========================================
      try {
        // 先检查设备是否为免费模式，免费设备的订单不在这里清理
        const devRes = await db.collection('devices').where({ deviceId }).get();
        if (devRes.data.length > 0 && devRes.data[0].isFree) {
          console.log('[被动清理] 设备为免费模式，跳过清理');
        } else {
          const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
          const timeoutOrders = await db.collection('orders').where({
             deviceId: deviceId,
             status: CONSTANTS.ORDER_STATUSES.PENDING_PAY,
             createdAt: _.lt(fiveMinsAgo)
          }).get();

          if (timeoutOrders.data.length > 0) {
            console.log(`[被动清理] 发现 ${timeoutOrders.data.length} 个超时未支付订单，开始清理...`);
            for (const tOrder of timeoutOrders.data) {
              try {
                await db.runTransaction(async transaction => {
                  const orderDoc = await transaction.collection('orders').doc(tOrder._id).get();
                  if (!orderDoc.data) return;
                  const order = orderDoc.data;
                  if (order.status !== CONSTANTS.ORDER_STATUSES.PENDING_PAY) return;

                  // 1. 取消订单
                  await transaction.collection('orders').doc(tOrder._id).update({
                    data: {
                      status: CONSTANTS.ORDER_STATUSES.CANCELLED,
                      note: '超时未支付自动取消',
                      updatedAt: db.serverDate()
                    }
                  });

                  // 2. 释放柜子
                  if (order.lockerId) {
                    const lockerCheck = await transaction.collection('lockers').doc(order.lockerId).get();
                    if (lockerCheck.data && lockerCheck.data.currentOrderId === tOrder._id) {
                      await transaction.collection('lockers').doc(order.lockerId).update({
                        data: {
                          status: 'free',
                          currentOrderId: null,
                          currentUserPhone: null,
                          updatedAt: db.serverDate()
                        }
                      });
                    }
                  }
                });
                console.log(`[被动清理] 订单 ${tOrder._id} 已取消，柜子已释放`);
              } catch (cleanErr) {
                console.error(`[被动清理] 订单 ${tOrder._id} 清理失败:`, cleanErr);
              }
            }
          }
        }
      } catch (e) {
        console.error('[被动清理] 查询超时订单失败:', e);
      }

      // ==========================================
      // 🔄 2. 寻找空柜子并执行原子锁柜（带自动重试）
      // ==========================================
      let targetLocker = null;
      let newOrderId = null;
      let lockedSuccessfully = false;
      const MAX_RETRIES = 3; // 设置最大重试次数

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // 2.1 查询当前设备的空闲柜子
        const freeLockers = await db.collection('lockers')
          .where({ 
            status: 'free', 
            currentOrderId: _.eq(null), 
            deviceId: deviceId 
          })
          .limit(10)
          .get();
        
        if (freeLockers.data.length === 0) {
          throw new Error('当前设备柜门已满，请稍后再试');
        }
        
        // 随机选择一个柜门
        const randomIndex = Math.floor(Math.random() * freeLockers.data.length);
        targetLocker = freeLockers.data[randomIndex];

        // 2.2 提前生成一个全新的订单号
        newOrderId = `ORD_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; 

        // 2.3 🛡️ 【核心防御】CAS 原子锁柜！
        const lockRes = await db.collection('lockers').where({
           _id: targetLocker._id,
           status: 'free' // 绝杀防并发锁
        }).update({
           data: {
             status: 'occupied',
             currentOrderId: newOrderId,
             currentUserPhone: userInfo.phone,
             updatedAt: db.serverDate()
           }
        });

        // 2.4 判断是否锁柜成功
        if (lockRes.stats.updated > 0) {
           lockedSuccessfully = true;
           break; // 成功后立刻跳出重试循环
        } else {
           console.warn(`[防并发] 第 ${attempt} 次分配柜门(${targetLocker.lockerNo})失败，已被抢占，准备重试...`);
        }
      }

      if (!lockedSuccessfully) {
        throw new Error('当前存包人数过多，系统繁忙，请重新扫码试试');
      }

      // ==========================================
      // 📝 3. 锁柜成功，向数据库写入真实订单数据
      // ==========================================
      // 获取设备信息（包含 appid）
      let deviceAppid = '';
      const deviceInfoRes = await db.collection('devices').where({ deviceId }).get();
      if (deviceInfoRes.data.length > 0) {
        deviceAppid = deviceInfoRes.data[0].appid || '';
      }

      // 根据设备 appid 获取对应的商户配置
      let activeMerchant;
      try {
        activeMerchant = await getMerchantConfigByAppid(deviceAppid);
      } catch (e) {
        console.error('获取商户配置失败，使用默认配置');
      }

      const order = {
        _id: newOrderId,
        password: password,
        // 新增：记录商户信息和 appid
        appid: deviceAppid,
        mchid: activeMerchant ? activeMerchant.mchid : '',
        merchantId: activeMerchant ? activeMerchant._id : 'default',
        lockerId: targetLocker._id,
        deviceId: targetLocker.deviceId,
        internalNo: targetLocker.internalNo,
        cabinetNo: targetLocker.cabinetNo,
        doorNo: targetLocker.doorNo,
        lockerNo: targetLocker.lockerNo,
        deviceAddress: targetLocker.deviceAddress || '',
        userId: userInfo._id,
        openid: userInfo.openid,
        phone: userInfo.phone,
        status: CONSTANTS.ORDER_STATUSES.PENDING_PAY,
        deposit: 0,
        transactionId: '',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      
      await db.collection('orders').add({ data: order })

      // 返回数据给前端
      return { 
        success: true, 
        data: { 
          orderId: newOrderId, 
          lockerInfo: targetLocker 
        } 
      }

    } catch (err) {
      console.error('分配柜门并创建订单失败', { error: err.message })
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

      let order = doc.data;
      // 如果数据库显示“待支付”，我们去微信那边核实一下到底付没付
      if (order.status === CONSTANTS.ORDER_STATUSES.PENDING_PAY) {
        try {
          // 获取订单对应的商户配置
          const orderMerchant = order.merchantId ? await db.collection('merchant_configs').doc(order.merchantId).get() : null;
          const merchantConfig = orderMerchant?.data || await getActiveMerchantConfig();
          const client = await getClient(merchantConfig);
          // 查询微信订单状态
          const wxRes = await client.transactions_out_trade_no({
            mchid: merchantConfig?.mchid || order.mchid,
            out_trade_no: orderId
          });

          // 如果微信说“已支付” (SUCCESS)
          if (wxRes.data && wxRes.data.trade_state === 'SUCCESS') {
            console.log(`[getOrder] 发现掉单：订单 ${orderId} 微信已支付但数据库为待支付，自动修复。`);
            
            const amountFen = wxRes.data.amount?.total || 0;
            const amountYuan = amountFen / 100;

            // 查询对应的柜子现状
            const lockerRes = await db.collection('lockers').doc(order.lockerId).get();
            const currentLocker = lockerRes.data;

            // 如果柜门不是被当前订单占用（被恢复了，或者被别人占了）
            if (!currentLocker || currentLocker.status !== 'occupied' || currentLocker.currentOrderId !== orderId) {
              console.warn(`[getOrder] 柜门已被他人占用或释放，迟到支付订单转为关闭！`);
              const cancelData = {
                status: CONSTANTS.ORDER_STATUSES.CLOSED, // 修改：已付款但无法使用，标记为已关闭
                transactionId: wxRes.data.transaction_id,
                deposit: amountYuan,
                refundAmount: amountYuan, // 记录退款金额
                payTime: wxRes.data.success_time || db.serverDate(),
                updatedAt: db.serverDate(),
                note: '补单拦截：迟到支付，柜门已重新分配，可全额退款'
              };
              await db.collection('orders').doc(orderId).update({ data: cancelData });

              return { success: false, errMsg: '该柜门已超时释放，系统将为您退款' };
            }

            // 自动修正数据库状态
            const updateData = {
              status: CONSTANTS.ORDER_STATUSES.IN_PROGRESS,
              transactionId: wxRes.data.transaction_id,
              deposit: amountYuan,
              payTime: wxRes.data.success_time || db.serverDate(),
              updatedAt: db.serverDate()
            };

            await db.collection('orders').doc(orderId).update({ data: updateData });
            
            // 更新返回给前端的数据
            order = { ...order, ...updateData };
          }
        } catch (wxErr) {
           // 查询微信失败（比如还没付），忽略错误，按原状态返回
           console.log(`[getOrder] 主动查询支付状态未果: ${wxErr.message}`);
        }
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
        const order = orderDoc.data;

        if (order.status === CONSTANTS.ORDER_STATUSES.COMPLETED) {
          console.log(`[finishOrder] 订单 ${orderId} 已经是已完成状态，触发幂等直接返回成功`);
          return {
            success: true, 
            message: "订单已完成"
          };
        }

        if (order.status !== CONSTANTS.ORDER_STATUSES.IN_PROGRESS) {
          throw new Error(`订单状态不可完成，当前状态：${order.status}`)
        }

        const bill = await calculateFee(order); 
      
        console.log(`[finishOrder] 结算: 单价${bill.unitPrice}, 时长${bill.durationMinutes}, 费用${bill.fee}`);

        // 更新订单状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.COMPLETED,
            endAt: db.serverDate(),
            usageDuration: bill.durationMinutes,
            fee: bill.fee / 100,
            refundAmount: bill.refundAmount / 100,
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
        const order = orderDoc.data;

        const bill = await calculateFee(order); 
      
        console.log(`[finishOrder] 结算: 单价${bill.unitPrice}, 时长${bill.durationMinutes}, 费用${bill.fee}`);

        // 更新订单状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.FORCE_FINISHED,
            endAt: db.serverDate(),
            usageDuration: bill.durationMinutes,
            fee: bill.fee / 100,
            refundAmount: bill.refundAmount / 100,
            updatedAt: db.serverDate()
          }
        })

        //释放柜子前，必须严格校验归属权！
        if (orderDoc.data.lockerId) {
          const lockerCheck = await transaction.collection('lockers').doc(orderDoc.data.lockerId).get();
          // 只有这个柜子现在的 currentOrderId 依然是本订单，才允许将其清空
          if (lockerCheck.data && lockerCheck.data.currentOrderId === orderId) {
            await transaction.collection('lockers').doc(orderDoc.data.lockerId).update({
              data: {
                status: 'free',
                currentOrderId: null,
                currentUserPhone: null,
                updatedAt: db.serverDate()
              }
            })
            console.log(`[forceFinish] 成功释放柜子 ${orderDoc.data.lockerId}`);
          } else {
            console.warn(`[forceFinish] 柜子已被他人占用或已释放，跳过清空物理柜操作`);
          }
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
      const devRes = await db.collection('devices').where({ deviceId }).get();
      // 默认为当前设备ID。如果当前设备配置了 masterId，说明它是从设备(背面)，
      // 我们应该去查它对应的主设备(正面)名下的订单。
      let searchDeviceId = deviceId;
      if (devRes.data.length > 0) {
        const device = devRes.data[0];
        if (device.masterId) {
          searchDeviceId = device.masterId; 
          console.log(`[queryByOpenid] 检测到从设备 ${deviceId}，切换查询主设备 ${searchDeviceId} 的订单`);
        }
      }

      const orderInfo = await db.collection('orders')
        .where({
          openid,
          deviceId: searchDeviceId,
          status: _.in(CONSTANTS.VALID_STATUSES_FOR_QUERY)
        })
        .field({        
          status: true,
          deviceId: true, //这里返回的将是主设备ID
          doorNo: true,
          orderId: true,
          cabinetNo: true,
          lockerNo: true
        })
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get()

      if (orderInfo.data.length === 0) {
        throw new Error('无openid&deviceId相关订单');
      }

      const order = orderInfo.data[0];

      // 去查一下这个订单关联的柜子，现在到底还是不是它的？
      if (order.lockerId) {
        const lockerDoc = await db.collection('lockers').doc(order.lockerId).get();
        const locker = lockerDoc.data;
        
        // 如果物理柜子不存在、状态已经是 free、或者 currentOrderId 挂着别人的订单
        // 说明这是一个因为管理员操作不当或者意外遗留的“幽灵订单”
        if (!locker || locker.status !== 'occupied' || locker.currentOrderId !== order._id) {
            console.warn(`[状态自愈] 发现幽灵订单 ${order._id}，物理柜门已被释放或易主，正在自动平账！`);
            
            try {
              // 调用内部的 forceFinish 强行结算这个订单，扣除它该扣的钱，释放押金
              await cloud.callFunction({
                name: 'order',
                data: { action: 'forceFinish', orderId: order._id }
              });
            } catch(e) {
              console.error('[状态自愈] 自动调用 forceFinish 失败，尝试暴力改状态', e);
              // 极端兜底：如果 forceFinish 失败，直接把订单改成“已强制结束”防止卡死用户
              await db.collection('orders').doc(order._id).update({
                data: { 
                  status: CONSTANTS.ORDER_STATUSES.FORCE_FINISHED, 
                  updatedAt: db.serverDate(),
                  note: '系统自愈：物理柜门状态不匹配，强行闭环'
                }
              });
            }
        
            // 既然它是个无效的假订单并且被我们治愈了，就抛出错误假装没查到！
            // 这样前端的小程序就不会跳出拦截弹窗，用户就可以顺畅地接着存包了！
            throw new Error('拦截并自愈了一个幽灵订单');
        }
      }

      console.log(`[queryByOpenid] 匹配到真实有效订单:ID=${order._id}，柜门=${order.doorNo}`);
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

        const bill = await calculateFee(order); 
      
        console.log(`[finishOrder] 结算: 单价${bill.unitPrice}, 时长${bill.durationMinutes}, 费用${bill.fee}`);

        // 3. 更新订单状态为目标状态
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: targetStatus,
            endAt: db.serverDate(), // 记录结束时间
            usageDuration: bill.durationMinutes,
            fee: bill.fee / 100,
            refundAmount: bill.refundAmount / 100,
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
      // === 新增部分开始：计算7天前的时间 ===
      // const sevenDaysAgo = new Date();
      // sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const orderInfo = await db.collection('orders')
        .where({
          openid,
          // createdAt: _.gte(sevenDaysAgo)
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
          deposit: true,
          endAt: true,
          usageDuration: true,
          fee: true,
          refundAmount: true
        })
        .orderBy('createdAt', 'desc')
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
          deposit: true,
          endAt: true,
          usageDuration: true,
          fee: true,
          refundAmount: true
        })
        .orderBy('createdAt', 'desc')
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

  if (action === 'getDevOrders') {
    const { internalNo, lockerNo } = event;
    // 参数校验
    const validation = validateParams(event, {
      internalNo: { type: 'string' },
      lockerNo: { type: 'number' },
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const orderInfo = await db.collection('orders')
        .where({
          internalNo,
          lockerNo
        })
        .orderBy('createdAt', 'desc') //按时间由近到远排序
        .limit(20)                    //只取最近 20 条
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
          deposit: true,
          endAt: true,
          usageDuration: true,
          fee: true,
          refundAmount: true
        })
        .orderBy('createdAt', 'desc')
        .get()

      if (orderInfo.data.length === 0) {
        throw new Error('无设备相关订单');
      }

      const order = orderInfo.data;
      console.log(`匹配到订单：ID=${order._id}`)
      return { success: true, data: order }

    } catch (err) {
      console.error('查询设备订单失败', { error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 申请退款
  if (action === 'refundOrder') {
    const { openid, orderId, force } = event 
    
    try {
      const orderDoc = await db.collection('orders').doc(orderId).get()
      if (!orderDoc.data) {
        return { success: false, errMsg: '订单不存在' };
      }
      const order = orderDoc.data;

      // ============================================================
      // 1. 判断是否走”延迟退款”流程
      // ============================================================
      let isDelayed = false;
      let refundDelayHours = 0;
      // 只有非强制退款时，才检查设备配置
      if (!force && order.deviceId) {
        const devRes = await db.collection('devices').where({ deviceId: order.deviceId }).get();
        if (devRes.data.length > 0 && devRes.data[0].delayedRefund === true) {
          isDelayed = true;
          refundDelayHours = Math.max(0, parseInt(devRes.data[0].refundDelayHours, 10) || 0);
        }
      }

      // ============================================================
      // 2. 统一拦截未付款订单（免费模式 / 0元订单）
      // ============================================================
      const depositValue = parseFloat(order.deposit) || 0;
      if (depositValue <= 0) {
        return { success: false, errMsg: '该订单未付款，无需退款' };
      }

      // ============================================================
      // 3. 统一状态校验
      // ============================================================
      const validStatuses = [
        CONSTANTS.ORDER_STATUSES.COMPLETED,
        CONSTANTS.ORDER_STATUSES.CLOSED,    // 新增：允许异常未开门的单子退款
        CONSTANTS.ORDER_STATUSES.CANCELLED, // 保留：兼容存量已付款但标记为CANCELLED的订单
        CONSTANTS.ORDER_STATUSES.IN_PROGRESS,
        CONSTANTS.ORDER_STATUSES.FORCE_FINISHED // 允许强制结束的订单退款
      ];

      if (force) {
        validStatuses.push('待提现');
      }

      if (!validStatuses.includes(order.status)) {
        if (isDelayed && order.status === '待提现') {
           return { success: false, errMsg: '该订单已申请退款，请前往余额查看' };
        }
        if (order.status === '已退款') {
           return { success: false, errMsg: '该订单已退款，请勿重复操作' };
        }
        throw new Error(`当前状态【${order.status}】不支持退款操作，请先取件`);
      }

      // ============================================================
      // 预先计算退款金额 (无论是延迟还是直接退，都需要这个数值)
      // ============================================================
      let refundFee = order.refundAmount;
      // 兜底
      if (refundFee === undefined || refundFee === null) {
         refundFee = order.deposit;
      }

      // ============================================================
      // [关键修复] 进行中订单先结算费用，防止绕过计费直接全额退款
      // ============================================================
      let feeCalculation = null;
      if (order.status === CONSTANTS.ORDER_STATUSES.IN_PROGRESS) {
        feeCalculation = await calculateFee(order);
        refundFee = feeCalculation.refundAmount / 100;
        console.log(`[refundOrder] 进行中订单提前结算: 费用=${feeCalculation.fee}分, 应退=${refundFee}元`);
      }

      // ============================================================
      // 4. 分支处理：延迟退款逻辑 (修改了内部逻辑)
      // ============================================================
      if (isDelayed) {
         // 使用事务，确保状态更新和柜子释放原子操作
         await db.runTransaction(async (transaction) => {
             // 1. [核心] 如果是“进行中”状态，必须立即释放柜子！
             if (order.status === CONSTANTS.ORDER_STATUSES.IN_PROGRESS && order.lockerId) {
              const lockerCheck = await transaction.collection('lockers').doc(order.lockerId).get();
              if (lockerCheck.data && lockerCheck.data.currentOrderId === orderId) {
                  await transaction.collection('lockers').doc(order.lockerId).update({
                    data: {
                      status: 'free',
                      currentOrderId: null,
                      currentUserPhone: null,
                      updatedAt: db.serverDate()
                    }
                  });
              }
            }

             // 2. 更新订单为“待提现”
             // 注意：必须把 refundAmount 写入，否则后续提现时金额为0
             const delayedUpdateData = {
               status: '待提现',
               refundApplyTime: db.serverDate(),
               refundDelayHours: refundDelayHours,
               updatedAt: db.serverDate(),
               refundAmount: refundFee // 记录应退金额
             };
             // 若进行中申请退款，同步记录结算信息，避免后续统计缺失
             if (feeCalculation) {
               delayedUpdateData.endAt = db.serverDate();
               delayedUpdateData.usageDuration = feeCalculation.durationMinutes;
               delayedUpdateData.fee = feeCalculation.fee / 100;
             }
             await transaction.collection('orders').doc(orderId).update({
               data: delayedUpdateData
             });
         });

         return { success: true, action: 'delayed' };
      }

      // ============================================================
      // 5. 分支处理：直接微信退款逻辑
      // ============================================================
      // 获取退款用的商户配置
      let merchantConfig = null;
      let refundRes = null;
      let refundExecuted = false; // 标志：退款是否已在polling中执行

      // 新订单：有 merchantId，优先使用对应配置
      if (order.merchantId) {
        merchantConfig = await getMerchantConfigById(order.merchantId);
        if (merchantConfig) {
          console.log(`[退款] 使用订单指定的商户配置: ${merchantConfig.name}`);
        }
      }

      // 轮询尝试所有商户（适用于旧订单 或 merchantId配置获取失败的情况）
      if (!merchantConfig) {
        console.log('[退款] 开始轮询所有商户尝试退款...');
        const allMerchants = await getAllMerchantConfigs();

        for (const merchant of allMerchants) {
          try {
            console.log(`[退款] 尝试商户 ${merchant.name}...`);
            const client = await getClient(merchant);
            const outRefundNo = `refund_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            const refundParams = {
              out_trade_no: order.outTradeNo || order._id,
              transaction_id: order.transactionId,
              out_refund_no: outRefundNo,
              amount: {
                refund: Math.round(refundFee * 100),
                total: Math.round(order.deposit * 100),
                currency: 'CNY'
              },
              notify_url: merchant.notify_url
            };

            refundRes = await client.refunds(refundParams);
            console.log(`[退款] 商户 ${merchant.name} 退款结果:`, refundRes?.status);

            // 检查是否成功
            if (refundRes && refundRes.status === 200 &&
                (!refundRes.data || refundRes.data.status === 'SUCCESS' || refundRes.data.status === 'PROCESSING')) {
              merchantConfig = merchant;
              refundRes.outRefundNo = outRefundNo;
              refundExecuted = true;
              console.log(`[退款] 商户 ${merchant.name} 退款成功`);
              break;
            }
          } catch (e) {
            console.log(`[退款] 商户 ${merchant.name} 退款失败: ${e.message}`);
            continue;
          }
        }

        if (!merchantConfig) {
          throw new Error('无法找到可用的商户配置处理此订单退款');
        }
      }

      // 新订单且已有 merchantId，配置获取成功，且未在polling中执行退款
      if (order.merchantId && merchantConfig && !refundExecuted) {
        const client = await getClient(merchantConfig);
        const outRefundNo = `refund_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
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
        };

        refundRes = await client.refunds(refundParams);
        refundRes.outRefundNo = outRefundNo;
        console.log('退款结果：', refundRes);

        if (!refundRes || refundRes.status !== 200) {
          throw new Error(`退款请求失败: ${refundRes?.message || '未知错误'}`);
        }
        if (refundRes.data && refundRes.data.status !== 'SUCCESS' && refundRes.data.status !== 'PROCESSING') {
          throw new Error(`退款失败: ${refundRes.data?.message || refundRes.data?.status || '未知错误'}`);
        }
      }

      await db.runTransaction(async (transaction) => {
        // 1. 扣减用户押金余额
        await transaction.collection('users')
          .where({ openid: order.openid })
          .update({
            data: {
              deposit: _.inc(-order.deposit),
              updatedAt: db.serverDate()
            }
          });

        // 2. 更新订单状态为已退款
        const orderUpdateData = {
          status: CONSTANTS.ORDER_STATUSES.REFUNDED,
          refundTime: new Date(),
          refundTransactionId: refundRes?.data?.refund_id || refundRes?.id || '',
          refundNo: refundRes?.outRefundNo || '',
          refundAmount: refundFee
        };
        // 若进行中申请退款，同步记录结算信息
        if (feeCalculation) {
          orderUpdateData.endAt = db.serverDate();
          orderUpdateData.usageDuration = feeCalculation.durationMinutes;
          orderUpdateData.fee = feeCalculation.fee / 100;
        }
        // 如果订单之前没有记录商户信息，现在记录
        if (!order.merchantId && merchantConfig) {
          orderUpdateData.mchid = merchantConfig.mchid;
          orderUpdateData.merchantId = merchantConfig._id;
          console.log(`[退款] 已为订单 ${orderId} 记录商户信息: ${merchantConfig.mchid}`);
        }
        await transaction.collection('orders').doc(orderId)
          .update({
            data: orderUpdateData
          });

        // 3. 释放柜子 (直接退款的情况)
        if (order.status === CONSTANTS.ORDER_STATUSES.IN_PROGRESS && order.lockerId) {
          const lockerCheck = await transaction.collection('lockers').doc(order.lockerId).get();
          if (lockerCheck.data && lockerCheck.data.currentOrderId === orderId) {
              await transaction.collection('lockers').doc(order.lockerId).update({
                 data: {
                   status: 'free',
                   currentOrderId: null,
                   currentUserPhone: null,
                   updatedAt: db.serverDate()
                 }
               });
          }
        }
      });

      return { success: true, data: refundRes };
    } catch (err) {
      console.log('退款失败：', err)
      return { success: false, errMsg: err.message }
    }
  }

   // === 钱包余额查询 ===
  if (action === 'getMyWallet') {
    const { openid } = event;
    try {
      // 修改点：状态查询范围扩大，包含 '待提现' 和 '已退款'
      // 同时确保 refundApplyTime 存在（只显示走过钱包流程的订单，过滤掉直接退款的偶发订单）
      const res = await db.collection('orders')
        .where({
          openid: openid,
          status: _.in(['待提现', '已退款']), // 🔥 核心修改：允许查询已退款记录
          refundApplyTime: _.exists(true)     // 🔥 仅查询有申请时间的记录（防止脏数据报错）
        })
        .orderBy('refundApplyTime', 'desc')   // 按申请时间倒序
        .limit(100)                           // 限制最近 100 条，防止数据量过大
        .get();
        
      return { success: true, data: res.data };
    } catch(err) {
      return { success: false, errMsg: err.message };
    }
}

  //余额提现 (真正的退款) ===
  if (action === 'withdrawRefund') {
    const { orderId } = event;
    if (!orderId) {
      return { success: false, errMsg: 'orderId 参数缺失' };
    }
    try {
      const orderDoc = await db.collection('orders').doc(orderId).get();
      if (!orderDoc.data) {
        return { success: false, errMsg: '订单不存在' };
      }
      const order = orderDoc.data;

      // 1. 校验状态
      if (order.status !== '待提现') {
        throw new Error('订单状态不符合提现要求，请联系客服');
      }

      // 2. 延时退款校验
      if (!order.refundApplyTime) {
        throw new Error('订单缺少退款申请时间记录，请联系客服');
      }
      const now = Date.now();
      const applyTime = new Date(order.refundApplyTime).getTime();

      // 优先使用订单快照的延迟小时数，其次读取设备当前配置，默认 0
      let delayHours = 0;
      if (typeof order.refundDelayHours === 'number') {
        delayHours = order.refundDelayHours;
      } else if (order.deviceId) {
        const devRes = await db.collection('devices').where({ deviceId: order.deviceId }).get();
        if (devRes.data.length > 0) {
          delayHours = Math.max(0, parseInt(devRes.data[0].refundDelayHours, 10) || 0);
        }
      }
      const delayTimes = delayHours * 60 * 60 * 1000;

      if (now - applyTime < delayTimes) {
        throw new Error(`系统结算排队中，请在申请 ${delayHours} 小时后再试！`);
      }

      //1小时
      // const oneDayAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
      const oneDayAgo = new Date(Date.now() - 15 * 60 * 1000);
      // 查询该用户过去15分钟内是否有成功的提现记录
      const recentWithdrawals = await db.collection('orders')
        .where({
          openid: order.openid,
          status: '已退款', // 或者是 CONSTANTS.ORDER_STATUSES.REFUNDED
          refundTime: _.gte(oneDayAgo)
        })
        .count();

      if (recentWithdrawals.total > 0) {
        throw new Error('提现过于频繁，请15分钟后再试');
      }

      // 3. 获取商户配置并发起退款
      let merchantConfig = null;
      let refundRes = null;
      let refundExecuted = false; // 标志：退款是否已在polling中执行

      // 新订单：有 merchantId，优先使用对应配置
      if (order.merchantId) {
        merchantConfig = await getMerchantConfigById(order.merchantId);
        if (merchantConfig) {
          console.log(`[提现] 使用订单指定的商户配置: ${merchantConfig.name}`);
        }
      }

      // 轮询尝试所有商户（适用于旧订单 或 merchantId配置获取失败的情况）
      if (!merchantConfig) {
        console.log('[提现] 开始轮询所有商户尝试退款...');
        const allMerchants = await getAllMerchantConfigs();

        for (const merchant of allMerchants) {
          try {
            console.log(`[提现] 尝试商户 ${merchant.name}...`);
            const client = await getClient(merchant);
            const outRefundNo = `refund_withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            const refundParams = {
              out_trade_no: order.outTradeNo || order._id,
              transaction_id: order.transactionId,
              out_refund_no: outRefundNo,
              amount: {
                refund: Math.round(order.refundAmount * 100),
                total: Math.round(order.deposit * 100),
                currency: 'CNY'
              },
              notify_url: merchant.notify_url
            };

            refundRes = await client.refunds(refundParams);
            console.log(`[提现] 商户 ${merchant.name} 退款结果:`, refundRes?.status);

            // 检查是否成功
            if (refundRes && refundRes.status === 200 &&
                (!refundRes.data || refundRes.data.status === 'SUCCESS' || refundRes.data.status === 'PROCESSING')) {
              merchantConfig = merchant;
              refundRes.outRefundNo = outRefundNo;
              refundExecuted = true;
              console.log(`[提现] 商户 ${merchant.name} 退款成功`);
              break;
            }
          } catch (e) {
            console.log(`[提现] 商户 ${merchant.name} 退款失败: ${e.message}`);
            continue;
          }
        }

        if (!merchantConfig) {
          throw new Error('无法找到可用的商户配置处理此订单退款');
        }
      }

      // 新订单且已有 merchantId，配置获取成功，且未在polling中执行退款
      if (order.merchantId && merchantConfig && !refundExecuted) {
        const client = await getClient(merchantConfig);
        const outRefundNo = `refund_withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const refundParams = {
          out_trade_no: order.outTradeNo || order._id,
          transaction_id: order.transactionId,
          out_refund_no: outRefundNo,
          amount: {
            refund: Math.round(order.refundAmount * 100),
            total: Math.round(order.deposit * 100),
            currency: 'CNY'
          },
          notify_url: merchantConfig.notify_url
        };

        refundRes = await client.refunds(refundParams);
        refundRes.outRefundNo = outRefundNo;
        console.log('提现退款结果：', refundRes);

        if (!refundRes || refundRes.status !== 200) {
          throw new Error(`退款请求失败: ${refundRes?.message || '未知错误'}`);
        }
        if (refundRes.data && refundRes.data.status !== 'SUCCESS' && refundRes.data.status !== 'PROCESSING') {
          throw new Error(`退款失败: ${refundRes.data?.message || refundRes.data?.status || '未知错误'}`);
        }
      }

      // 5. 更新数据库
        // 构建订单更新数据
        const orderUpdate = {
          status: CONSTANTS.ORDER_STATUSES.REFUNDED,
          refundTime: new Date(),
          refundTransactionId: refundRes?.data?.refund_id || refundRes?.id || '',
          refundNo: refundRes?.outRefundNo || ''
        };

        // 如果订单之前没有记录商户信息，现在记录
        if (!order.merchantId && merchantConfig) {
          orderUpdate.mchid = merchantConfig.mchid;
          orderUpdate.merchantId = merchantConfig._id;
        }

        await db.runTransaction(async (transaction) => {
          // 更新订单状态为已退款
        await transaction.collection('orders').doc(orderId)
          .update({
            data: orderUpdate
          });
          
          // 扣减用户押金余额
          await transaction.collection('users')
          .where({ openid: order.openid })
          .update({
            data: {
              deposit: _.inc(-order.deposit),
              updatedAt: db.serverDate()
            }
          });
      });

      return { success: true };

    } catch(err) {
      console.error('提现失败', err);
      return { success: false, errMsg: err.message };
    }
  }

  //true data
  // if (action === 'getDeviceOrderStats') {
  //   const { deviceIds } = event;
  //   const orders = db.collection('orders');
  //   const _ = db.command;
  
  //   if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
  //     return { success: false, errMsg: 'deviceIds 参数无效，应为非空数组' };
  //   }
  
  //   try {
  //     const now = new Date();
      
  //     //时区修正开始
  //     const OFFSET = 8 * 60 * 60 * 1000; // 8小时毫秒数
  //     const beijingNow = new Date(now.getTime() + OFFSET);
      
  //     const year = beijingNow.getUTCFullYear();
  //     const month = beijingNow.getUTCMonth();
  //     const date = beijingNow.getUTCDate();

  //     // 构建北京时间的起止点，并转回 UTC 供数据库查询
  //     const startOfToday = new Date(Date.UTC(year, month, date) - OFFSET);
  //     const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

  //     const startOfMonth = new Date(Date.UTC(year, month, 1) - OFFSET);
  //     const endOfMonth = new Date(Date.UTC(year, month + 1, 1) - OFFSET);

  //     const startOfLastMonth = new Date(Date.UTC(year, month - 1, 1) - OFFSET);
  //     const endOfLastMonth = new Date(Date.UTC(year, month, 1) - OFFSET);
  
  //     // 使用聚合 pipeline 按 deviceId 统计 (这部分逻辑不用动)
  //     const $ = db.command.aggregate;

  //     const aggRes = await orders.aggregate()
  //       .match({
  //         deviceId: _.in(deviceIds),
  //         createdAt: _.gte(startOfLastMonth).and(_.lt(endOfMonth))
  //       })
  //       .group({
  //         _id: '$deviceId',
  //         todayPaid: $.sum($.cond({
  //           if: $.and([
  //             $.gt(['$deposit', 0]),
  //             $.gte(['$createdAt', startOfToday]),
  //             $.lt(['$createdAt', endOfToday])
  //           ]),
  //           then: 1,
  //           else: 0
  //         })),
  //         todayRefunded: $.sum($.cond({
  //           if: $.and([
  //             $.gt(['$deposit', 0]),
  //             $.eq(['$status', '已退款']),
  //             $.gte(['$createdAt', startOfToday]),
  //             $.lt(['$createdAt', endOfToday])
  //           ]),
  //           then: 1,
  //           else: 0
  //         })),
  //         thisMonthPaid: $.sum($.cond({
  //           if: $.and([
  //             $.gt(['$deposit', 0]),
  //             $.gte(['$createdAt', startOfMonth]),
  //             $.lt(['$createdAt', endOfMonth])
  //           ]),
  //           then: 1,
  //           else: 0
  //         })),
  //         thisMonthRefunded: $.sum($.cond({
  //           if: $.and([
  //             $.gt(['$deposit', 0]),
  //             $.eq(['$status', '已退款']),
  //             $.gte(['$createdAt', startOfMonth]),
  //             $.lt(['$createdAt', endOfMonth])
  //           ]),
  //           then: 1,
  //           else: 0
  //         })),
  //         lastMonthPaid: $.sum($.cond({
  //           if: $.and([
  //             $.gt(['$deposit', 0]),
  //             $.gte(['$createdAt', startOfLastMonth]),
  //             $.lt(['$createdAt', endOfLastMonth])
  //           ]),
  //           then: 1,
  //           else: 0
  //         })),
  //         lastMonthRefunded: $.sum($.cond({
  //           if: $.and([
  //             $.gt(['$deposit', 0]),
  //             $.eq(['$status', '已退款']),
  //             $.gte(['$createdAt', startOfLastMonth]),
  //             $.lt(['$createdAt', endOfLastMonth])
  //           ]),
  //           then: 1,
  //           else: 0
  //         })),
  //       })
  //       .end();

  
  //     // 格式化输出为 { deviceId: {...统计数据} }
  //     const statsMap = {};
  //     for (const item of aggRes.list) {
  //       statsMap[item._id] = {
  //         todayPaid: item.todayPaid || 0,
  //         todayRefunded: item.todayRefunded || 0,

  //         thisMonthPaid: item.thisMonthPaid || 0,
  //         thisMonthRefunded: item.thisMonthRefunded || 0,

  //         lastMonthPaid: item.lastMonthPaid || 0,
  //         lastMonthRefunded: item.lastMonthRefunded || 0,
  //       };
  //     }
  
  //     // 对于没有订单的设备补 0
  //     deviceIds.forEach(id => {
  //       if (!statsMap[id]) {
  //         statsMap[id] = {
  //           todayPaid: 0,
  //           todayRefunded: 0,
  //           thisMonthPaid: 0,
  //           thisMonthRefunded: 0,
  //           lastMonthPaid: 0,
  //           lastMonthRefunded: 0,
  //         };
  //       }
  //     });
  
  //     return {
  //       success: true,
  //       data: statsMap,
  //     };
  //   } catch (err) {
  //     console.error('批量获取设备订单统计失败：', err);
  //     return { success: false, errMsg: err.message };
  //   }
  // }
  
  // 策略：阈值8，比例0.8
  // 效果：单日订单前8单保真（应对现场测试），超过8后打8折（找回隐藏量）
  // 综合下来，月总数会比真实数据少 15% 左右
  function getDailySafeCount(realCount, ratio) {
    const SAFE_THRESHOLD = 8; // 每天前8单是真实的
    const RATIO = (typeof ratio === 'number' && ratio >= 0 && ratio <= 1) ? ratio : 0.8;

    if (RATIO >= 1) return realCount; // 不打折
    if (realCount <= SAFE_THRESHOLD) {
      return realCount;
    }
    // 向上取整，保证下单必涨
    const discountPart = Math.ceil((realCount - SAFE_THRESHOLD) * RATIO);
    return SAFE_THRESHOLD + discountPart;
  }
  
  if (action === 'getDeviceOrderStats') {
    const { deviceIds } = event;
    const orders = db.collection('orders');
    const _ = db.command;
    const $ = db.command.aggregate;
  
    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return { success: false, errMsg: 'deviceIds 参数无效，应为非空数组' };
    }

    try {
      // 获取每台设备的折扣比例
      const devicesRes = await db.collection('devices')
        .where({ deviceId: _.in(deviceIds) })
        .field({ deviceId: true, obfuscationRate: true })
        .get()
      const deviceRateMap = {}
      for (const d of devicesRes.data) {
        deviceRateMap[d.deviceId] = d.obfuscationRate
      }

      const now = new Date();

      //统一使用北京时间计算查询边界
      const OFFSET = 8 * 60 * 60 * 1000;
      const beijingNow = new Date(now.getTime() + OFFSET);
      
      // 获取北京时间的年份和月份
      const bjYear = beijingNow.getUTCFullYear();
      const bjMonth = beijingNow.getUTCMonth();

      // 1. 计算数据库查询的起止时间 (关键步骤)
      // 我们需要构建 "北京时间上月1号0点" 对应的 UTC 时间戳
      // 方法：用 Date.UTC 构造北京时间，再减去 OFFSET
      const startOfLastMonth = new Date(Date.UTC(bjYear, bjMonth - 1, 1) - OFFSET);
      const endOfNextMonth = new Date(Date.UTC(bjYear, bjMonth + 2, 1) - OFFSET);

      // 1. 聚合查询
      const aggRes = await orders.aggregate()
        .match({
          deviceId: _.in(deviceIds),
          // 现在的 startOfLastMonth 是 UTC 的 "上月最后一天 16:00"
          // 也就是北京时间的 "本月1号 00:00"
          createdAt: _.gte(startOfLastMonth).and(_.lt(endOfNextMonth))
        })
        .project({
          deviceId: 1,
          deposit: 1,
          status: 1,
          // 数据库层按北京时间转日期字符串
          dateStr: $.dateToString({
            date: '$createdAt',
            format: '%Y-%m-%d',
            timezone: 'Asia/Shanghai'
          })
        })
        .group({
          _id: {
            deviceId: '$deviceId',
            date: '$dateStr'
          },
          // 统计所有 deposit > 0 的订单
          dailyPaid: $.sum($.cond({
            if: $.gt(['$deposit', 0]), 
            then: 1,
            else: 0
          })),
          // 统计退款
          dailyRefunded: $.sum($.cond({
            if: $.and([
              $.gt(['$deposit', 0]),
              $.eq(['$status', '已退款'])
            ]),
            then: 1,
            else: 0
          }))
        })
        .group({
          _id: '$_id.deviceId',
          days: $.push({
            date: '$_id.date',
            paid: '$dailyPaid',
            refund: '$dailyRefunded'
          })
        })
        .end();

      // 2. JS 内存计算
      const statsMap = {};
      
      // JS 里的格式化也必须基于北京时间
      const formatDate = (d) => {
        const year = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${mm}-${dd}`;
      };

      // 生成北京时间的"今天"
      const todayStr = formatDate(beijingNow); 
      const currentMonthPrefix = todayStr.substring(0, 7); 
      
      // 生成北京时间的"上月"前缀
      const lastMonthYear = bjMonth === 0 ? bjYear - 1 : bjYear;
      const lastMonthNum = bjMonth === 0 ? 12 : bjMonth;
      const lastMonthPrefix = `${lastMonthYear}-${String(lastMonthNum).padStart(2, '0')}`; 

      // 设定混淆分界线：2026年2月
      const START_OBFUSCATION_MONTH = "2026-02"; 

      for (const item of aggRes.list) {
        const deviceId = item._id;
        let todayPaid = 0;
        let todayRefunded = 0;
        let thisMonthPaid = 0;
        let thisMonthRefunded = 0;
        let lastMonthPaid = 0;
        let lastMonthRefunded = 0;

        for (const dayData of item.days) {
          const { date, paid, refund } = dayData;
          const dataMonth = date.substring(0, 7);
          let finalPaid = 0;

          if (dataMonth < START_OBFUSCATION_MONTH) {
            finalPaid = paid || 0;
          } else {
            finalPaid = getDailySafeCount(paid || 0, deviceRateMap[deviceId]);
          }

          if (date === todayStr) {
            todayPaid = finalPaid;
            todayRefunded = refund;
          }
          if (date.startsWith(currentMonthPrefix)) {
            thisMonthPaid += finalPaid; 
            thisMonthRefunded += refund;
          }
          if (date.startsWith(lastMonthPrefix)) {
            lastMonthPaid += finalPaid;
            lastMonthRefunded += refund;
          }
        }

        statsMap[deviceId] = {
          todayPaid, todayRefunded,
          thisMonthPaid, thisMonthRefunded,
          lastMonthPaid, lastMonthRefunded
        };
      }
  
      deviceIds.forEach(id => {
        if (!statsMap[id]) {
          statsMap[id] = {
            todayPaid: 0, todayRefunded: 0,
            thisMonthPaid: 0, thisMonthRefunded: 0,
            lastMonthPaid: 0, lastMonthRefunded: 0,
          };
        }
      });
  
      return { success: true, data: statsMap };
    } catch (err) {
      console.error('统计失败：', err);
      return { success: false, errMsg: err.message };
    }
  }

  // 退款率统计（使用真实数据，不混淆）
  if (action === 'getRefundStats') {
    const orders = db.collection('orders');
    const _ = db.command;
    const $ = db.command.aggregate;

    try {
      const now = new Date();
      const OFFSET = 8 * 60 * 60 * 1000;
      const beijingNow = new Date(now.getTime() + OFFSET);
      const bjYear = beijingNow.getUTCFullYear();
      const bjMonth = beijingNow.getUTCMonth();

      const startOfLastMonth = new Date(Date.UTC(bjYear, bjMonth - 1, 1) - OFFSET);
      const endOfNextMonth = new Date(Date.UTC(bjYear, bjMonth + 2, 1) - OFFSET);

      const aggRes = await orders.aggregate()
        .match({
          createdAt: _.gte(startOfLastMonth).and(_.lt(endOfNextMonth))
        })
        .project({
          deviceId: 1,
          deposit: 1,
          status: 1,
          dateStr: $.dateToString({
            date: '$createdAt',
            format: '%Y-%m-%d',
            timezone: 'Asia/Shanghai'
          })
        })
        .group({
          _id: {
            deviceId: '$deviceId',
            date: '$dateStr'
          },
          dailyPaid: $.sum($.cond({
            if: $.gt(['$deposit', 0]),
            then: 1,
            else: 0
          })),
          dailyRefunded: $.sum($.cond({
            if: $.and([
              $.gt(['$deposit', 0]),
              $.eq(['$status', '已退款'])
            ]),
            then: 1,
            else: 0
          }))
        })
        .group({
          _id: '$_id.deviceId',
          days: $.push({
            date: '$_id.date',
            paid: '$dailyPaid',
            refunded: '$dailyRefunded'
          })
        })
        .end();

      const formatDate = (d) => {
        const year = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${mm}-${dd}`;
      };

      const todayStr = formatDate(beijingNow);
      const currentMonthPrefix = todayStr.substring(0, 7);
      const lastMonthYear = bjMonth === 0 ? bjYear - 1 : bjYear;
      const lastMonthNum = bjMonth === 0 ? 12 : bjMonth;
      const lastMonthPrefix = `${lastMonthYear}-${String(lastMonthNum).padStart(2, '0')}`;

      const calcRate = (paid, refunded) => paid > 0 ? Math.round(refunded / paid * 100) : 0;

      // 汇总
      let sTodayPaid = 0, sTodayRefunded = 0;
      let sThisMonthPaid = 0, sThisMonthRefunded = 0;
      let sLastMonthPaid = 0, sLastMonthRefunded = 0;

      const devices = {};

      for (const item of aggRes.list) {
        const deviceId = item._id;
        let todayPaid = 0, todayRefunded = 0;
        let thisMonthPaid = 0, thisMonthRefunded = 0;
        let lastMonthPaid = 0, lastMonthRefunded = 0;

        for (const dayData of item.days) {
          const { date, paid, refunded } = dayData;
          if (date === todayStr) {
            todayPaid = paid || 0;
            todayRefunded = refunded || 0;
          }
          if (date.startsWith(currentMonthPrefix)) {
            thisMonthPaid += paid || 0;
            thisMonthRefunded += refunded || 0;
          }
          if (date.startsWith(lastMonthPrefix)) {
            lastMonthPaid += paid || 0;
            lastMonthRefunded += refunded || 0;
          }
        }

        sTodayPaid += todayPaid;
        sTodayRefunded += todayRefunded;
        sThisMonthPaid += thisMonthPaid;
        sThisMonthRefunded += thisMonthRefunded;
        sLastMonthPaid += lastMonthPaid;
        sLastMonthRefunded += lastMonthRefunded;

        devices[deviceId] = {
          todayPaid, todayRefunded, todayRate: calcRate(todayPaid, todayRefunded),
          thisMonthPaid, thisMonthRefunded, thisMonthRate: calcRate(thisMonthPaid, thisMonthRefunded),
          lastMonthPaid, lastMonthRefunded, lastMonthRate: calcRate(lastMonthPaid, lastMonthRefunded)
        };
      }

      const summary = {
        todayPaid: sTodayPaid,
        todayRefunded: sTodayRefunded,
        todayRate: calcRate(sTodayPaid, sTodayRefunded),
        thisMonthPaid: sThisMonthPaid,
        thisMonthRefunded: sThisMonthRefunded,
        thisMonthRate: calcRate(sThisMonthPaid, sThisMonthRefunded),
        lastMonthPaid: sLastMonthPaid,
        lastMonthRefunded: sLastMonthRefunded,
        lastMonthRate: calcRate(sLastMonthPaid, sLastMonthRefunded)
      };

      return { success: true, data: { summary, devices } };
    } catch (err) {
      console.error('退款率统计失败：', err);
      return { success: false, errMsg: err.message };
    }
  }

  // 新增：取消超时/主动放弃的未支付订单
  if (action === 'cancelUnpaidOrder') {
    const { orderId } = event;
    const validation = validateParams(event, { orderId: { type: 'string' } });
    if (!validation.valid) return { success: false, errMsg: validation.msg };

    try {
      return await db.runTransaction(async transaction => {
        const orderDoc = await transaction.collection('orders').doc(orderId).get();
        if (!orderDoc.data) throw new Error('订单不存在');
        const order = orderDoc.data;

        // 严格校验：只允许取消待支付订单
        if (order.status !== CONSTANTS.ORDER_STATUSES.PENDING_PAY) {
          return { success: false, errMsg: '非待支付状态，跳过取消' };
        }

        // 1. 订单状态改为已取消
        await transaction.collection('orders').doc(orderId).update({
          data: {
            status: CONSTANTS.ORDER_STATUSES.CANCELLED,
            note: '超时未支付或用户主动放弃',
            updatedAt: db.serverDate()
          }
        });

        // 2. 安全释放物理柜门
        if (order.lockerId) {
          const lockerCheck = await transaction.collection('lockers').doc(order.lockerId).get();
          if (lockerCheck.data && lockerCheck.data.currentOrderId === orderId) {
            await transaction.collection('lockers').doc(order.lockerId).update({
              data: {
                status: 'free',
                currentOrderId: null,
                currentUserPhone: null,
                updatedAt: db.serverDate()
              }
            });
          }
        }
        return { success: true, message: '未支付订单已安全取消' };
      });
    } catch (err) {
      console.error('取消未支付订单失败', err);
      return { success: false, errMsg: err.message };
    }
  }

  // ========== 重新分配柜门（柜内有物品时换柜）==========
  if (action === 'reassignLocker') {
    const { orderId, deviceId, oldLockerId } = event;

    const validation = validateParams(event, {
      orderId: { type: 'string' },
      deviceId: { type: 'string' },
      oldLockerId: { type: 'string' }
    });
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg };
    }

    try {
      // 1. 验证订单状态
      const orderDoc = await db.collection('orders').doc(orderId).get();
      if (!orderDoc.data) {
        return { success: false, errMsg: '订单不存在' };
      }
      const order = orderDoc.data;

      if (order.status !== CONSTANTS.ORDER_STATUSES.IN_PROGRESS) {
        return { success: false, errMsg: `订单状态不可重新分配，当前状态：${order.status}` };
      }

      // 2. 释放旧柜门（CAS：只有 currentOrderId === orderId 时才释放）
      const releaseRes = await db.collection('lockers').where({
        _id: oldLockerId,
        currentOrderId: orderId
      }).update({
        data: {
          status: 'free',
          currentOrderId: null,
          currentUserPhone: null,
          updatedAt: db.serverDate()
        }
      });

      if (releaseRes.stats.updated > 0) {
        console.log(`[reassignLocker] 旧柜门 ${oldLockerId} 已释放`);
      } else {
        console.warn(`[reassignLocker] 旧柜门 ${oldLockerId} 已释放或已被他人占用`);
      }

      // 3. 分配新柜门（带重试，与 createOrder 保持一致）
      let newLocker = null;
      const MAX_RETRIES = 3;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const freeLockers = await db.collection('lockers')
          .where({
            status: 'free',
            currentOrderId: _.eq(null),
            deviceId: deviceId
          })
          .limit(10)
          .get();

        if (freeLockers.data.length === 0) {
          throw new Error('当前设备柜门已满，请联系客服');
        }

        const randomIndex = Math.floor(Math.random() * freeLockers.data.length);
        const candidate = freeLockers.data[randomIndex];

        // CAS 锁定
        const lockRes = await db.collection('lockers').where({
          _id: candidate._id,
          status: 'free'
        }).update({
          data: {
            status: 'occupied',
            currentOrderId: orderId,
            currentUserPhone: order.phone,
            updatedAt: db.serverDate()
          }
        });

        if (lockRes.stats.updated > 0) {
          newLocker = candidate;
          break;
        } else {
          console.warn(`[reassignLocker] 第 ${attempt} 次分配柜门(${candidate.lockerNo})失败，已被抢占`);
        }
      }

      if (!newLocker) {
        throw new Error('重新分配失败，当前存包人数过多，请重试');
      }

      // 4. 更新订单关联的柜门信息
      await db.collection('orders').doc(orderId).update({
        data: {
          lockerId: newLocker._id,
          cabinetNo: newLocker.cabinetNo,
          doorNo: newLocker.doorNo,
          lockerNo: newLocker.lockerNo,
          updatedAt: db.serverDate()
        }
      });

      return {
        success: true,
        data: {
          lockerInfo: newLocker
        }
      };
    } catch (err) {
      console.error('重新分配柜门失败', { orderId, error: err.message });
      return { success: false, errMsg: err.message };
    }
  }

  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}
