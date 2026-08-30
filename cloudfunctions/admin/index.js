const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const { getLockerServerUrl, getCurrentMiniProgram, clearCache } = require('./utils/config');


const batchCreateLockers = async (event) => {
  const { internalNo, deviceAddress, deviceDeposit, unitPrice, delayedRefund, refundDelayHours, screenNo,cabinetCount, lockersPerCabinet } = event

  // 验证参数
  if (!internalNo || !deviceAddress || deviceDeposit === undefined || unitPrice === undefined || !screenNo || !cabinetCount || !lockersPerCabinet) {
    return {
      success: false,
      errMsg: '请指定设备ID、设备地址、设备收费标准、收费策略、屏幕编号、锁板数量和每个锁板的锁数量'
    }
  }

  // 校验提现等待时间
  const parsedRefundDelayHours = Math.max(0, parseInt(refundDelayHours, 10) || 0)

  // 验证设备是否存在
  const deviceCheck = await db.collection('devices')
    .where({ internalNo: internalNo })
    .get()
  if (deviceCheck.data.length === 0) {
    return {
      success: false,
      errMsg: `设备 ${internalNo} 不存在，请先创建设备`
    }
  }else{
    await db.collection('devices')
      .where({ internalNo: internalNo })
      .update({
        data: {
          cabinetCount: parseInt(cabinetCount),  // 锁板数量
          doorCount: parseInt(lockersPerCabinet),// 锁数量
          isConfigured: true,                    // 标记为已配置
          deviceAddress: deviceAddress,          // 设备地址
          deviceDeposit: deviceDeposit,
          unitPrice: unitPrice,
          delayedRefund: Boolean(delayedRefund),
          refundDelayHours: parsedRefundDelayHours,
          screenNo: screenNo,
          updatedAt: db.serverDate()             // 更新时间
        }
      });
  }

  const deviceId = deviceCheck.data[0].deviceId;
  try {
    const lockers = []
    let lockerNo = 1;

    // 生成锁数据（关联设备）
    for (let cabinetNo = 1; cabinetNo <= cabinetCount; cabinetNo++) {
      for (let doorNo = 1; doorNo <= lockersPerCabinet; doorNo++) {
        lockers.push({
          deviceId: deviceId,    // 关联设备ID
          internalNo: internalNo,
          deviceAddress: deviceAddress,
          deviceDeposit: deviceDeposit,
          cabinetNo: cabinetNo,  // 锁板编号
          doorNo: doorNo,        // 锁编号
          lockerNo: lockerNo,
          status: 'free',        // 初始空闲
          currentOrderId: null,
          currentUserPhone: null,
          updatedAt: db.serverDate()
        })
        lockerNo++;
      }
    }

    //先清除记录再添加lockers
    await db.collection('lockers').where({
      deviceId: deviceId // 匹配要清除的deviceId
    }).remove();

    // 批量插入lockers集合
    const result = await db.collection('lockers').add({
      data: lockers
    })

    //将屏幕柜门设为不可打开
    await db.collection('lockers')
    .where({ deviceId: deviceId, lockerNo: screenNo })
    .update({
      data: {
        status: 'occupied',
      }
    });

    const createdCount = result._ids.length;
    return {
      success: true,
      count: createdCount,
      message: `为设备 ${deviceId} 成功生成 ${createdCount} 个锁具`
    }
  } catch (err) {
    console.error('批量生成锁具失败', err)
    return { success: false, errMsg: err.message }
  }
}

// ==========================================
// 内部函数：更新设备退款配置（设备卡片快捷修改）
// ==========================================
const updateDeviceRefundConfig = async (event) => {
  const { deviceId, delayedRefund, refundDelayHours } = event

  if (!deviceId) {
    return { success: false, errMsg: '缺少设备ID' }
  }

  const deviceCheck = await db.collection('devices').where({ deviceId }).get()
  if (deviceCheck.data.length === 0) {
    return { success: false, errMsg: `设备 ${deviceId} 不存在` }
  }

  const parsedRefundDelayHours = Math.max(0, parseInt(refundDelayHours, 10) || 0)

  await db.collection('devices').where({ deviceId }).update({
    data: {
      delayedRefund: Boolean(delayedRefund),
      refundDelayHours: parsedRefundDelayHours,
      updatedAt: db.serverDate()
    }
  })

  return {
    success: true,
    message: `设备 ${deviceId} 退款配置已更新`,
    delayedRefund: Boolean(delayedRefund),
    refundDelayHours: parsedRefundDelayHours
  }
}

// ==========================================
// 内部函数：迁移设备退款延迟配置（一次性）
// ==========================================
const migrateRefundConfig = async () => {
  try {
    // 1. delayedRefund: true → delayedRefund: true, refundDelayHours: 12
    const trueRes = await db.collection('devices')
      .where({ delayedRefund: true })
      .update({
        data: {
          refundDelayHours: 12,
          updatedAt: db.serverDate()
        }
      });

    // 2. delayedRefund: false → delayedRefund: false, refundDelayHours: 0
    const falseRes = await db.collection('devices')
      .where({ delayedRefund: false })
      .update({
        data: {
          refundDelayHours: 0,
          updatedAt: db.serverDate()
        }
      });

    // 3. delayedRefund 字段缺失 → delayedRefund: false, refundDelayHours: 0
    const missingRes = await db.collection('devices')
      .where({ delayedRefund: _.exists(false) })
      .update({
        data: {
          delayedRefund: false,
          refundDelayHours: 0,
          updatedAt: db.serverDate()
        }
      });

    return {
      success: true,
      message: '设备退款配置迁移完成',
      trueUpdated: trueRes.stats.updated || 0,
      falseUpdated: falseRes.stats.updated || 0,
      missingUpdated: missingRes.stats.updated || 0
    };
  } catch (e) {
    console.error('迁移设备退款配置失败:', e);
    return { success: false, errMsg: e.message };
  }
}

// ==========================================
// 内部函数：添加商户配置（商户管理页面一键绑定）
// 流程：参数校验 → 查重 → 凭证实测(不入库) → mini_programs 处理 → 入库 → 自动配置投诉回调
// ==========================================
async function addMerchant(event) {
  const {
    name, mchid, merchantSerialNo, apiv3Key, appid, certSuffix, order = 99,
    notify_url, miniName, complaintNotifyUrl,
    privateKey: privateKeyText, publicCert: publicCertText
  } = event;

  if (!name || !mchid) {
    return { success: false, errMsg: '请提供商户名称和mchid' };
  }

  // 如果有 certSuffix，用 certSuffix 作为 _id；否则用 merchant_mchid
  const merchantId = certSuffix || `merchant_${mchid}`;

  try {
    // ---------- 1. 参数校验 ----------
    const mchidStr = String(mchid).trim();
    if (!/^\d{6,32}$/.test(mchidStr)) {
      return { success: false, errMsg: '商户号格式无效（应为6~32位数字）' };
    }
    if (!apiv3Key || String(apiv3Key).length !== 32) {
      return { success: false, errMsg: 'APIv3密钥格式无效（应为32位）' };
    }
    if (!appid) {
      return { success: false, errMsg: '请填写商户关联的小程序appid' };
    }
    const notifyUrl = (notify_url || '').trim();
    if (!notifyUrl || !notifyUrl.startsWith('https://')) {
      return { success: false, errMsg: '退款回调地址必填且必须以 https:// 开头' };
    }

    let privateKey = (privateKeyText || '').trim();
    let publicCert = (publicCertText || '').trim();

    // 证书文本完全未提供时，回退到本地文件读取（兼容旧的文件+部署流程）
    // 注意：只在两者都缺失时兜底，避免部分缺失时把其他商户的证书混装进来
    if (!privateKey && !publicCert) {
      try {
        const certFiles = [];
        if (certSuffix) {
          certFiles.push(
            { key: `./private/apiclient_key_${certSuffix}.pem`, cert: `./private/apiclient_cert_${certSuffix}.pem` },
            { key: `./private/pub_key_${certSuffix}.pem`, cert: `./private/apiclient_cert_${certSuffix}.pem` }
          );
        }
        certFiles.push(
          { key: `./private/apiclient_key_${merchantId.replace('merchant_', '')}.pem`, cert: `./private/apiclient_cert_${merchantId.replace('merchant_', '')}.pem` },
          { key: `./private/apiclient_key.pem`, cert: `./private/apiclient_cert.pem` },
          { key: `./private/apiclient_key_yh.pem`, cert: `./private/apiclient_cert_yh.pem` },
          { key: `./private/apiclient_key_xyh.pem`, cert: `./private/apiclient_cert_xyh.pem` },
          { key: `./private/apiclient_key_sxkj.pem`, cert: `./private/apiclient_cert_sxkj.pem` }
        );
        for (const files of certFiles) {
          try {
            if (!privateKey && fs.existsSync(files.key)) {
              privateKey = fs.readFileSync(files.key, 'utf8');
              console.log(`[添加商户] 从文件读取私钥: ${files.key}`);
            }
            if (!publicCert && fs.existsSync(files.cert)) {
              publicCert = fs.readFileSync(files.cert, 'utf8');
              console.log(`[添加商户] 从文件读取证书: ${files.cert}`);
            }
            if (privateKey && publicCert) break;
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        console.log('[添加商户] 读取证书文件失败:', e.message);
      }
    }

    if (!privateKey || !privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
      return { success: false, errMsg: '缺少商户私钥：请提供 apiclient_key.pem 内容（选择文件或粘贴）' };
    }
    try {
      crypto.createPrivateKey(privateKey);
    } catch (e) {
      return { success: false, errMsg: '商户私钥格式无效，无法解析，请检查是否完整复制' };
    }

    const isCert = publicCert.includes('-----BEGIN CERTIFICATE-----');
    const isPubKey = publicCert.includes('-----BEGIN PUBLIC KEY-----');
    if (!publicCert || (!isCert && !isPubKey)) {
      return { success: false, errMsg: '缺少证书/公钥：请提供 apiclient_cert.pem（商户证书）或 pub_key.pem（微信支付公钥）内容' };
    }

    let serialNo = (merchantSerialNo || '').trim();
    // 序列号未填且提供的是商户证书时，尝试自动解析（Node>=15.6，低版本环境跳过）
    if (!serialNo && isCert && typeof crypto.X509Certificate === 'function') {
      try {
        serialNo = new crypto.X509Certificate(publicCert).serialNumber;
        console.log('[添加商户] 从证书自动解析序列号:', serialNo);
      } catch (e) {
        // 解析失败则要求手填
      }
    }
    if (!serialNo || !/^[0-9A-Fa-f]{10,40}$/.test(serialNo)) {
      return { success: false, errMsg: isPubKey && !serialNo
        ? '公钥模式无法自动解析序列号，请手动填写证书序列号'
        : '证书序列号格式无效（10~40位十六进制）' };
    }

    // ---------- 2. 查重 ----------
    const existing = await db.collection('merchant_configs').where({ _id: merchantId }).get();
    if (existing.data && existing.data.length > 0) {
      return { success: false, errMsg: `商户ID ${merchantId} 已存在` };
    }
    const dupMchid = await db.collection('merchant_configs').where({ mchid: mchidStr }).get();
    if (dupMchid.data && dupMchid.data.length > 0) {
      return { success: false, errMsg: `商户号 ${mchidStr} 已绑定过（若刚提交成功，请在列表中查看并点击"切换使用"）` };
    }

    // ---------- 3. 入库前凭证实测（不通过则不写库） ----------
    let verifyRes;
    try {
      const r = await cloud.callFunction({
        name: 'wxpay-complaint',
        data: {
          action: 'verifyCredentials',
          mchid: mchidStr,
          merchantSerialNo: serialNo,
          privateKey,
          apiv3Key: String(apiv3Key)
        }
      });
      verifyRes = r.result;
    } catch (e) {
      verifyRes = { success: false, errMsg: '凭证验证服务调用失败：' + e.message };
    }
    if (!verifyRes || !verifyRes.success) {
      return { success: false, errMsg: (verifyRes && verifyRes.errMsg) || '凭证验证失败', step: 'verify' };
    }
    const verifyWarning = verifyRes.warning || '';

    // ---------- 4. mini_programs 处理 ----------
    let miniProgramCreated = false;
    try {
      const miniRes = await db.collection('mini_programs').where({ appid }).get();
      if (miniRes.data && miniRes.data.length > 0) {
        if (miniName && miniRes.data[0].miniName !== miniName) {
          await db.collection('mini_programs').where({ appid }).update({
            data: { miniName, updatedAt: db.serverDate() }
          });
        }
      } else if (miniName) {
        await db.collection('mini_programs').add({
          data: { appid, miniName, isActive: true, createdAt: db.serverDate() }
        });
        miniProgramCreated = true;
      }
      clearCache();
    } catch (e) {
      console.error('[添加商户] mini_programs 处理失败:', e);
    }

    // ---------- 5. 插入商户配置 ----------
    const result = await db.collection('merchant_configs').add({
      data: {
        _id: merchantId,
        name: name,
        mchid: mchidStr,
        merchantSerialNo: serialNo,
        apiv3Key: apiv3Key || '',
        appid: appid || '',
        privateKey: privateKey,
        publicCert: publicCert,
        notify_url: notifyUrl,
        isActive: false,
        order: order,
        // 健康度管理默认字段
        status: 'normal',
        dailyOrderLimit: 0,
        complaintRateLimit: 0,
        statsDate: '',
        todayOrders: 0,
        todayComplaints: 0,
        totalOrders: 0,
        totalComplaints: 0,
        consecutivePayFails: 0,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

    // ---------- 6. 自动配置投诉回调（失败不影响入库，可重试） ----------
    let notifyInit = null;
    if (complaintNotifyUrl) {
      try {
        const r = await cloud.callFunction({
          name: 'wxpay-complaint',
          data: {
            action: 'initNotifyUrl',
            appid: appid,
            mchid: mchidStr,
            notifyUrl: complaintNotifyUrl
          }
        });
        notifyInit = r.result;
      } catch (e) {
        notifyInit = { success: false, errMsg: e.message };
      }
    }

    return {
      success: true,
      message: `商户 ${name} 添加成功`,
      merchantId: result._id,
      hasCert: true,
      miniProgramCreated,
      verifyWarning,
      notifyInit
    };
  } catch (e) {
    console.error('添加商户失败:', e);
    return { success: false, errMsg: e.message };
  }
}

// ==========================================
// 内部函数：初始化商户配置
// ==========================================
async function initMerchantConfig() {
  try {
    // 检查是否已存在
    const existing = await db.collection('merchant_configs').where({ _id: 'yh' }).get();

    // 读取私钥文件（从云函数目录）
    let privateKey = '';
    let publicCert = '';
    try {
      const privateKeyPath = './private/apiclient_key_yh.pem';
      const publicCertPath = './private/apiclient_cert_yh.pem';
      if (fs.existsSync(privateKeyPath)) {
        privateKey = fs.readFileSync(privateKeyPath, 'utf8');
        console.log('[初始化] 成功读取私钥文件，长度:', privateKey.length);
      }
      if (fs.existsSync(publicCertPath)) {
        publicCert = fs.readFileSync(publicCertPath, 'utf8');
        console.log('[初始化] 成功读取证书文件，长度:', publicCert.length);
      }
      if (!privateKey || !publicCert) {
        console.log('[初始化] 证书文件为空，可能未上传到云函数目录');
      }
    } catch (e) {
      console.log('[初始化] 读取证书文件失败:', e.message);
    }

    if (existing.data.length > 0) {
      // 已存在，强制更新证书内容
      const updateData = {
        updatedAt: db.serverDate()
      };
      // 强制更新证书（无论是否已有值）
      if (privateKey) {
        updateData.privateKey = privateKey;
      }
      if (publicCert) {
        updateData.publicCert = publicCert;
      }

      if (Object.keys(updateData).length > 1) {
        await db.collection('merchant_configs').doc('yh').update({ data: updateData });
        console.log('[初始化] 证书已更新，长度:', privateKey?.length, publicCert?.length);
        return { success: true, message: '商户配置已更新' };
      }
      return { success: true, message: '商户配置已存在且无需更新' };
    }

    // 插入默认商户配置（不从环境变量读取，需要手动在数据库配置）
    await db.collection('merchant_configs').add({
      data: {
        _id: 'yh',
        name: '珊星设备',
        mchid: '',
        merchantSerialNo: '',
        apiv3Key: '',
        privateKey: privateKey,
        publicCert: publicCert,
        isActive: true,
        order: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

    return { success: true, message: '商户配置初始化成功' };
  } catch (e) {
    console.error('初始化商户配置失败:', e);
    return { success: false, errMsg: e.message };
  }
}

// ==========================================
// 内部函数：初始化第二个商户配置
// ==========================================
async function initSecondMerchant() {
  try {
    const existing = await db.collection('merchant_configs').where({ _id: 'xyh' }).get();

    // 读取第二个商户的证书文件
    let privateKey = '';
    let publicCert = '';
    try {
      const privateKeyPath = './private/apiclient_key_xyh.pem';
      const publicCertPath = './private/apiclient_cert_xyh.pem';
      if (fs.existsSync(privateKeyPath)) {
        privateKey = fs.readFileSync(privateKeyPath, 'utf8');
        console.log('[初始化XYH] 成功读取私钥文件');
      }
      if (fs.existsSync(publicCertPath)) {
        publicCert = fs.readFileSync(publicCertPath, 'utf8');
        console.log('[初始化XYH] 成功读取证书文件');
      }
    } catch (e) {
      console.log('[初始化XYH] 读取证书文件失败:', e.message);
    }

    if (existing.data.length > 0) {
      // 已存在，强制更新证书（无论是否已有值）
      const updateData = { updatedAt: db.serverDate() };
      if (privateKey) updateData.privateKey = privateKey;
      if (publicCert) updateData.publicCert = publicCert;

      if (Object.keys(updateData).length > 1) {
        await db.collection('merchant_configs').doc('xyh').update({ data: updateData });
        console.log('[初始化XYH] 证书已更新，长度:', privateKey?.length, publicCert?.length);
        return { success: true, message: '第二个商户配置已更新' };
      }
      return { success: true, message: '第二个商户配置已存在且无需更新' };
    }

    // 插入第二个商户配置（不从环境变量读取，需要手动在数据库配置）
    await db.collection('merchant_configs').add({
      data: {
        _id: 'xyh',
        name: '珊星智能存储',
        mchid: '',
        merchantSerialNo: '',
        apiv3Key: '',
        privateKey: privateKey,
        publicCert: publicCert,
        isActive: false,
        order: 2,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

    return { success: true, message: '第二个商户配置初始化成功' };
  } catch (e) {
    console.error('初始化第二个商户配置失败:', e);
    return { success: false, errMsg: e.message };
  }
}

// ==========================================
// 内部函数：更新商户证书
// ==========================================
async function updateMerchantCert(event) {
  const { merchantId } = event;

  if (!merchantId) {
    return { success: false, errMsg: '请提供商户ID' };
  }

  try {
    const merchant = await db.collection('merchant_configs').doc(merchantId).get();
    if (!merchant.data || merchant.data.length === 0) {
      return { success: false, errMsg: '商户不存在' };
    }

    const merchantName = merchant.data[0].name;

    // 读取证书文件
    let privateKey = '';
    let publicCert = '';
    const certSuffix = merchantId.replace('merchant_', '');

    const certFiles = [
      { key: `./private/apiclient_key_${certSuffix}.pem`, cert: `./private/apiclient_cert_${certSuffix}.pem` },
      { key: `./private/apiclient_key.pem`, cert: `./private/apiclient_cert.pem` },
      { key: `./private/apiclient_key_yh.pem`, cert: `./private/apiclient_cert_yh.pem` },
      { key: `./private/apiclient_key_xyh.pem`, cert: `./private/apiclient_cert_xyh.pem` },
    ];

    for (const files of certFiles) {
      try {
        if (fs.existsSync(files.key)) {
          privateKey = fs.readFileSync(files.key, 'utf8');
          console.log(`[更新证书] 找到私钥: ${files.key}`);
        }
        if (fs.existsSync(files.cert)) {
          publicCert = fs.readFileSync(files.cert, 'utf8');
          console.log(`[更新证书] 找到证书: ${files.cert}`);
        }
        if (privateKey && publicCert) break;
      } catch (e) {
        continue;
      }
    }

    if (!privateKey || !publicCert) {
      return { success: false, errMsg: '未找到证书文件，请确保证书已放在 admin/private/ 目录下' };
    }

    await db.collection('merchant_configs').doc(merchantId).update({
      data: {
        privateKey: privateKey,
        publicCert: publicCert,
        updatedAt: db.serverDate()
      }
    });

    return {
      success: true,
      message: `商户 ${merchantName} 证书已更新`,
      privateKeyLength: privateKey.length,
      publicCertLength: publicCert.length
    };
  } catch (e) {
    console.error('更新商户证书失败:', e);
    return { success: false, errMsg: e.message };
  }
}

exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const { OPENID } = wxContext

  // 初始化商户配置不需要管理员权限
  if (action === 'initMerchantConfig') {
    return await initMerchantConfig();
  }

  // 初始化第二个商户配置（XYH珊星智能存储）
  if (action === 'initSecondMerchant') {
    return await initSecondMerchant();
  }

  // 更新商户证书
  if (action === 'updateMerchantCert') {
    return await updateMerchantCert(event);
  }

  // 清空所有设备的柜门（优化版：直接操作数据库）
  if (action === 'clearAllLockers') {
    try {
      // 1. 获取所有设备信息
      const devices = await db.collection('devices').field({
        deviceId: true,
        screenNo: true
      }).get();

      if (devices.data.length === 0) {
        return { success: true, message: '没有设备，无需清柜' };
      }

      let totalCleared = 0;
      let totalOrders = 0;

      // 2. 遍历所有设备
      for (const device of devices.data) {
        const deviceId = device.deviceId;
        const screenNo = device.screenNo;

        // 找出所有非 free、非 broken 的柜门（排除屏幕柜）
        const occupiedLockers = await db.collection('lockers')
          .where({
            deviceId,
            status: _.nin(['free', 'broken']),
            lockerNo: screenNo ? _.neq(screenNo) : _.exists(true)
          })
          .get();

        if (occupiedLockers.data.length > 0) {
          // 收集订单ID并批量结束
          const orderIds = occupiedLockers.data
            .map(l => l.currentOrderId)
            .filter(id => id && id !== null);

          if (orderIds.length > 0) {
            // [修复] 过滤掉已退款/已取消/已关闭等终态订单，防止状态回退
            const finalStatuses = ['已退款', '已取消', '已关闭'];
            const orderRes = await db.collection('orders')
              .where({ _id: _.in(orderIds) })
              .field({ status: true })
              .get();
            const activeOrderIds = orderRes.data
              .filter(o => !finalStatuses.includes(o.status))
              .map(o => o._id);

            if (activeOrderIds.length > 0) {
              await db.collection('orders')
                .where({ _id: _.in(activeOrderIds) })
                .update({
                  data: {
                    status: '已强制结束',
                    endAt: db.serverDate(),
                    updatedAt: db.serverDate(),
                    note: '管理员一键清柜强制结束'
                  }
                });
              totalOrders += activeOrderIds.length;
            }
          }

          // 批量释放柜门
          const lockerIds = occupiedLockers.data.map(l => l._id);
          await db.collection('lockers')
            .where({ _id: _.in(lockerIds) })
            .update({
              data: {
                status: 'free',
                currentOrderId: null,
                currentUserPhone: null,
                updatedAt: db.serverDate()
              }
            });

          totalCleared += occupiedLockers.data.length;
        }
      }

      return {
        success: true,
        message: `清柜完成：释放 ${totalCleared} 个柜门，结束 ${totalOrders} 个订单`
      };
    } catch (e) {
      console.error('清空所有柜门失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 调试日志
  console.log('[admin] action:', action, 'OPENID:', OPENID);

  // 管理员权限验证接口（查询数据库，super和device都能进入后台）
  if (action === 'amIAdmin') {
    const res = await db.collection('admin_permission').where({
      openid: OPENID
    }).get();
    if (res.data.length === 0) {
      return { isAdmin: false };
    }
    const info = res.data[0];
    return {
      isAdmin: true,
      role: info.type,
      allowedDevices: info.allowedDevices || []
    };
  }

  // adminPermission 查询（不需要超级管理员，super和device都可以）
  if (action === 'adminPermission') {
    const res = await db.collection('admin_permission').where({ openid: OPENID }).get();
    if (!res.data.length) {
      return { isAdmin: false };
    }
    const info = res.data[0];
    return {
      isAdmin: true,
      role: info.type,
      allowedDevices: info.allowedDevices || []
    };
  }

  // 获取设备列表（带归属信息）- 普通管理员也可以查看
  if (action === 'getDevices') {
    try {
      // 从 locker_server 获取所有设备归属映射
      let deviceAppidMap = {};
      try {
        const lockerUrl = await getLockerServerUrl();
        const adminToken = process.env.ADMIN_TOKEN;
        const mapRes = await axios.get(`${lockerUrl}/listDeviceAppid`, {
          headers: { 'x-admin-token': adminToken },
          timeout: 5000
        });
        if (mapRes.data?.code === 200) {
          deviceAppidMap = mapRes.data.data || {};
        }
      } catch (err) {
        console.warn('[getDevices] 从 locker_server 获取映射失败:', err.message);
      }

      // 查询本地数据库所有设备（不分页，按编号从小到大返回）
      const devicesRes = await db.collection('devices')
        .orderBy('internalNo', 'asc')
        .get();

      // 获取小程序列表用于显示名称
      const miniProgramsRes = await db.collection('mini_programs')
        .where({ isActive: true })
        .get();

      const appidToName = {};
      miniProgramsRes.data.forEach(p => {
        appidToName[p.appid] = p.miniName;
      });

      // 组装数据（显示实际归属）
      const devices = devicesRes.data.map(d => {
        // 优先使用 locker_server 的映射，其次使用本地记录的 appid
        const mapEntry = deviceAppidMap[d.deviceId];
        const actualAppid = mapEntry?.appid || d.appid || wxContext.APPID;
        return {
          ...d,
          belongsToAppid: actualAppid,
          belongsToName: appidToName[actualAppid] || d.miniName || '未知小程序',
          isLocal: actualAppid === wxContext.APPID
        };
      });

      return { success: true, data: devices, total: devices.length };
    } catch (e) {
      console.error('获取设备列表失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 验证超级管理员权限（以上action之后的操作需要超级管理员）
  const adminRes = await db.collection('admin_permission').where({
    openid: OPENID,
    type: 'super'
  }).get();
  if (adminRes.data.length === 0) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  // 添加商户配置（商户管理页面一键绑定，需超级管理员）
  if (action === 'addMerchant') {
    return await addMerchant(event);
  }

  // 重新配置投诉回调（添加商户后 notifyInit 失败时重试，也可独立排障）
  if (action === 'initComplaintNotify') {
    const { appid, mchid, notifyUrl } = event;
    if (!appid || !notifyUrl) {
      return { success: false, errMsg: '缺少 appid 或 notifyUrl' };
    }
    try {
      const r = await cloud.callFunction({
        name: 'wxpay-complaint',
        data: { action: 'initNotifyUrl', appid, mchid, notifyUrl }
      });
      return r.result || { success: false, errMsg: '调用投诉回调配置失败' };
    } catch (e) {
      console.error('配置投诉回调失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 删除商户配置（需超级管理员；使用中或存在未完成关联订单的商户不可删除）
  if (action === 'deleteMerchant') {
    const { merchantId } = event;
    if (!merchantId) {
      return { success: false, errMsg: '缺少商户ID' };
    }
    try {
      let merchant;
      try {
        const merchantRes = await db.collection('merchant_configs').doc(merchantId).get();
        merchant = merchantRes.data;
      } catch (e) {
        return { success: false, errMsg: '商户不存在或已被删除' };
      }
      if (!merchant || !merchant.mchid) {
        return { success: false, errMsg: '商户不存在或已被删除' };
      }

      // 规则一：使用中的商户不能删除（收退款依赖当前激活商户，先切换走）
      if (merchant.isActive) {
        return { success: false, errMsg: '该商户正在使用中，请先切换到其他商户后再删除' };
      }

      // 规则二：存在未完成关联订单的商户不能删除
      // （退款/提现按 order.merchantId 定位商户配置，删除后这些订单将无法退款；老订单可能只存 mchid）
      const related = _.or([{ merchantId: merchantId }, { mchid: merchant.mchid }]);
      const BLOCK_STATUSES = ['待支付', '进行中', '待提现', '已强制结束'];
      const pendingRes = await db.collection('orders')
        .where(_.and([related, { status: _.in(BLOCK_STATUSES) }]))
        .count();
      if (pendingRes.total > 0) {
        return { success: false, errMsg: `有 ${pendingRes.total} 笔未完成订单关联该商户（删除后无法退款），不能删除` };
      }

      const totalRes = await db.collection('orders').where(related).count();
      const historicalCount = totalRes.total || 0;

      await db.collection('merchant_configs').doc(merchantId).remove();
      clearCache();

      return {
        success: true,
        message: `商户 ${merchant.name} 已删除`,
        historicalCount
      };
    } catch (e) {
      console.error('删除商户失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 切换设备归属（调用 locker_server）
  if (action === 'switchDeviceAppid') {
    const { deviceId, targetAppid } = event;

    if (!deviceId || !targetAppid) {
      return { success: false, errMsg: '缺少设备ID或目标appid' };
    }

    try {
      // 1. 获取设备当前数据
      const deviceRes = await db.collection('devices').where({ deviceId }).get();
      if (deviceRes.data.length === 0) {
        return { success: false, errMsg: '设备不存在' };
      }
      const deviceData = deviceRes.data[0];

      // 2. 验证目标 appid 有效（从 mini_programs 查询），并读取 cloudUrl
      const miniProgram = await db.collection('mini_programs').where({ appid: targetAppid }).get();
      if (miniProgram.data.length === 0) {
        return { success: false, errMsg: '无效的小程序appid' };
      }
      const targetCloudUrl = miniProgram.data[0].cloudUrl;
      if (!targetCloudUrl) {
        return { success: false, errMsg: '目标小程序未配置 cloudUrl' };
      }

      // 3. 调用 locker_server 执行切换
      const lockerUrl = await getLockerServerUrl();
      const adminToken = process.env.ADMIN_TOKEN;
      await axios.post(`${lockerUrl}/setDeviceAppid`, {
        deviceId,
        appid: targetAppid,
        cloudUrl: targetCloudUrl,
        deviceData: {
          internalNo: deviceData.internalNo,
          cabinetCount: deviceData.cabinetCount,
          doorCount: deviceData.doorCount,
          deviceAddress: deviceData.deviceAddress,
          screenNo: deviceData.screenNo
        }
      }, {
        headers: { 'x-admin-token': adminToken },
        timeout: 10000
      });

      // 4. 更新本地数据库 appid
      await db.collection('devices').where({ deviceId }).update({
        data: {
          appid: targetAppid,
          miniName: miniProgram.data[0].miniName,
          updatedAt: db.serverDate()
        }
      });

      // 5. 清除配置缓存，避免读取到旧的 miniName
      clearCache();

      return {
        success: true,
        message: `设备已切换到 ${miniProgram.data[0].miniName}，设备将重新连接`
      };
    } catch (e) {
      console.error('切换设备归属失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 批量创建储物柜
  if (action === 'batchCreateLockers') {
    return await batchCreateLockers(event)
  }

  // 更新设备退款配置
  if (action === 'updateDeviceRefundConfig') {
    return await updateDeviceRefundConfig(event)
  }

  // 一次性迁移设备退款配置（可调用后删除）
  if (action === 'migrateRefundConfig') {
    return await migrateRefundConfig()
  }

  // 获取所有商户配置
  if (action === 'getMerchantConfigs') {
    try {
      const userAppid = wxContext.APPID;
      console.log('[getMerchantConfigs] userAppid:', userAppid);
      const query = {};
      // 按当前小程序的 appid 过滤（超级管理员也按此过滤）
      if (userAppid) {
        query.appid = userAppid;
      }
      console.log('[getMerchantConfigs] query:', query);
      const merchants = await db.collection('merchant_configs')
        .where(query)
        .orderBy('order', 'asc')
        .field({
          privateKey: false,  // 不返回私钥
          publicCert: false   // 不返回证书
        })
        .get();
      console.log('[getMerchantConfigs] found:', merchants.data.length);

      // 附带全局限额配置（不存在则按不限处理）
      let limits = { dailyOrderLimit: 0, complaintRateLimit: 0 };
      try {
        const limitsRes = await db.collection('system_configs').doc('merchant_limits').get();
        if (limitsRes.data) {
          limits = {
            dailyOrderLimit: Number(limitsRes.data.dailyOrderLimit) || 0,
            complaintRateLimit: Number(limitsRes.data.complaintRateLimit) || 0
          };
        }
      } catch (e) {
        console.warn('[getMerchantConfigs] 读取全局限额失败，按不限处理:', e.message);
      }

      // 默认回调地址（用于添加商户表单预填）：优先取当前 appid 商户，其次取任意商户（同环境域名共用）
      let defaultNotifyUrl = '';
      const fromList = merchants.data.find(m => m.notify_url);
      if (fromList) {
        defaultNotifyUrl = fromList.notify_url;
      } else {
        try {
          const anyRes = await db.collection('merchant_configs').limit(1).get();
          if (anyRes.data && anyRes.data[0] && anyRes.data[0].notify_url) {
            defaultNotifyUrl = anyRes.data[0].notify_url;
          }
        } catch (e) {
          console.warn('[getMerchantConfigs] 读取默认回调地址失败:', e.message);
        }
      }

      return { success: true, data: merchants.data, limits, defaultNotifyUrl };
    } catch (e) {
      console.error('获取商户配置失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 切换激活商户
  if (action === 'switchMerchant') {
    const { merchantId } = event;
    const userAppid = wxContext.APPID;

    if (!merchantId) {
      return { success: false, errMsg: '缺少商户ID' };
    }

    try {
      // 验证目标商户是否存在
      const targetMerchant = await db.collection('merchant_configs').doc(merchantId).get();
      // doc().get() 返回单个对象，不是数组
      if (!targetMerchant.data) {
        return { success: false, errMsg: '商户不存在' };
      }

      // 限制状态的商户禁止切换（force 为应急后门，界面不暴露）
      if (targetMerchant.data.status === 'restricted' && !event.force) {
        return { success: false, errMsg: '该商户处于限制状态，请先恢复正常后再切换' };
      }

      // 验证目标商户是否属于当前小程序
      if (userAppid && targetMerchant.data.appid !== userAppid) {
        return { success: false, errMsg: '无权切换其他小程序的商户' };
      }

      // 事务：取消当前小程序的所有商户激活状态，设置目标商户为激活
      await db.runTransaction(async (transaction) => {
        // 1. 取消当前小程序所有商户的激活状态
        await transaction.collection('merchant_configs')
          .where({ appid: targetMerchant.data.appid, isActive: true })
          .update({ data: { isActive: false } });

        // 2. 设置目标商户为激活
        await transaction.collection('merchant_configs')
          .doc(merchantId)
          .update({
            data: {
              isActive: true,
              updatedAt: db.serverDate()
            }
          });
      });

      return { success: true, message: `已切换到商户: ${targetMerchant.data.name}` };
    } catch (e) {
      console.error('切换商户失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 修改商户状态（正常/限制）
  if (action === 'updateMerchantStatus') {
    const { merchantId, status } = event;
    const userAppid = wxContext.APPID;

    if (!merchantId || !['normal', 'restricted'].includes(status)) {
      return { success: false, errMsg: '参数错误：merchantId 或 status 无效' };
    }

    try {
      const merchantRes = await db.collection('merchant_configs').doc(merchantId).get();
      if (!merchantRes.data) {
        return { success: false, errMsg: '商户不存在' };
      }
      const merchant = merchantRes.data;

      // 验证商户归属当前小程序
      if (userAppid && merchant.appid !== userAppid) {
        return { success: false, errMsg: '无权操作其他小程序的商户' };
      }

      const updateData = {
        status: status,
        statusReason: status === 'restricted' ? '管理员手动标记限制' : '',
        statusUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate()
      };
      // 恢复正常时清零连续失败计数
      if (status === 'normal') {
        updateData.consecutivePayFails = 0;
      }

      await db.collection('merchant_configs').doc(merchantId).update({ data: updateData });

      // 若被限制的是当前激活商户，自动切换到下一个可用商户
      let switchResult = null;
      if (status === 'restricted' && merchant.isActive) {
        try {
          const res = await cloud.callFunction({
            name: 'merchant',
            data: { action: 'autoSwitch', appid: merchant.appid, reason: 'manual_restrict', excludeId: merchantId }
          });
          switchResult = res.result;
        } catch (e) {
          console.error('[updateMerchantStatus] 自动切换失败:', e);
        }
      }

      return {
        success: true,
        message: status === 'restricted' ? '已标记为限制状态' : '已恢复正常',
        autoSwitch: switchResult
      };
    } catch (e) {
      console.error('修改商户状态失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 修改全局限额配置（所有商户统一标准，0 表示不限）
  if (action === 'updateMerchantLimits') {
    const { dailyOrderLimit, complaintRateLimit } = event;

    const orderLimit = Number(dailyOrderLimit);
    const rateLimit = Number(complaintRateLimit);
    if (isNaN(orderLimit) || orderLimit < 0 || !Number.isInteger(orderLimit)) {
      return { success: false, errMsg: '订单限额须为不小于 0 的整数（0 表示不限）' };
    }
    if (isNaN(rateLimit) || rateLimit < 0 || rateLimit > 100) {
      return { success: false, errMsg: '投诉率阈值须在 0~100 之间（0 表示不限）' };
    }

    try {
      // set = 覆盖式 upsert：文档不存在则创建
      await db.collection('system_configs').doc('merchant_limits').set({
        data: {
          dailyOrderLimit: orderLimit,
          complaintRateLimit: rateLimit,
          updatedAt: db.serverDate()
        }
      });

      return { success: true, message: '全局限额已更新' };
    } catch (e) {
      console.error('修改全局限额失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 设置商户是否参与自动轮换（关闭后只能手动切换，适合备用号）
  if (action === 'updateMerchantAutoRotate') {
    const { merchantId, autoRotate } = event;
    const userAppid = wxContext.APPID;

    if (!merchantId || typeof autoRotate !== 'boolean') {
      return { success: false, errMsg: '参数错误：merchantId 或 autoRotate 无效' };
    }

    try {
      const merchantRes = await db.collection('merchant_configs').doc(merchantId).get();
      if (!merchantRes.data) {
        return { success: false, errMsg: '商户不存在' };
      }
      if (userAppid && merchantRes.data.appid !== userAppid) {
        return { success: false, errMsg: '无权操作其他小程序的商户' };
      }

      await db.collection('merchant_configs').doc(merchantId).update({
        data: {
          autoRotate: autoRotate,
          updatedAt: db.serverDate()
        }
      });

      return { success: true, message: autoRotate ? '已加入自动轮换' : '已移出自动轮换（可手动切换）' };
    } catch (e) {
      console.error('设置自动轮换失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 更新设备归属小程序
  if (action === 'updateDeviceAppid') {
    const { deviceId, appid } = event;

    if (!deviceId || !appid) {
      return { success: false, errMsg: '缺少设备ID或appid' };
    }

    try {
      // 验证设备是否存在
      const device = await db.collection('devices').where({ deviceId }).get();
      if (!device.data || device.data.length === 0) {
        return { success: false, errMsg: '设备不存在' };
      }

      // 验证 appid 是否有效（统一从 mini_programs 校验）
      const miniProgram = await db.collection('mini_programs').where({ appid }).get();
      if (!miniProgram.data || miniProgram.data.length === 0) {
        return { success: false, errMsg: '无效的小程序appid' };
      }

      const miniName = miniProgram.data[0].miniName;

      // 更新设备归属
      await db.collection('devices').where({ deviceId }).update({
        data: {
          appid: appid,
          miniName: miniName,
          updatedAt: db.serverDate()
        }
      });

      return { success: true, message: `已将设备归属改为: ${miniName}` };
    } catch (e) {
      console.error('更新设备归属失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 获取小程序列表（从 mini_programs）
  if (action === 'getMiniPrograms') {
    try {
      const res = await db.collection('mini_programs')
        .where({ isActive: true })
        .field({ appid: true, miniName: true })
        .orderBy('createdAt', 'asc')
        .get();

      return { success: true, data: res.data };
    } catch (e) {
      console.error('获取小程序列表失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 按设备设置免费模式（不影响其他设备）
  if (action === 'setDeviceFree') {
    const { deviceId, isFree } = event;

    if (!deviceId) {
      return { success: false, errMsg: '缺少设备ID' };
    }

    try {
      // 验证设备是否存在
      const device = await db.collection('devices').where({ deviceId }).get();
      if (!device.data || device.data.length === 0) {
        return { success: false, errMsg: '设备不存在' };
      }

      // 更新设备的免费模式
      // 处理字符串 "true"/"false" 转布尔值
      const isFreeValue = isFree === true || isFree === 'true';
      await db.collection('devices').where({ deviceId }).update({
        data: {
          isFree: isFreeValue,
          updatedAt: db.serverDate()
        }
      });

      return {
        success: true,
        message: `设备 ${device.data[0].internalNo} 已${isFreeValue ? '开启' : '关闭'}免费模式`
      };
    } catch (e) {
      console.error('设置设备免费模式失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 设置设备订单数显示折扣比例
  if (action === 'updateObfuscationRate') {
    const { deviceId, obfuscationRate } = event;

    if (!deviceId) {
      return { success: false, errMsg: '缺少设备ID' };
    }

    // 验证参数：0-1之间的小数，或-1表示使用默认值
    const rate = parseFloat(obfuscationRate);
    if (isNaN(rate) || rate < -1 || rate > 1) {
      return { success: false, errMsg: '折扣比例无效，请输入0-100的数字' };
    }

    try {
      const device = await db.collection('devices').where({ deviceId }).get();
      if (!device.data || device.data.length === 0) {
        return { success: false, errMsg: '设备不存在' };
      }

      // -1 表示删除字段（使用全局默认值）
      const updateData = rate < 0
        ? { obfuscationRate: _.remove(), updatedAt: db.serverDate() }
        : { obfuscationRate: rate, updatedAt: db.serverDate() };

      await db.collection('devices').where({ deviceId }).update({ data: updateData });

      const displayRate = rate < 0 ? '默认(20%)' : `${Math.round((1 - rate) * 100)}%`;
      return { success: true, message: `订单显示折扣已设置为：${displayRate}` };
    } catch (e) {
      console.error('设置折扣比例失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 获取当前设置了免费模式的设备列表
  if (action === 'getFreeDevices') {
    try {
      const result = await db.collection('devices')
        .where({ isFree: true })
        .field({
          deviceId: true,
          internalNo: true,
          deviceAddress: true,
          isOnline: true
        })
        .get();

      return {
        success: true,
        data: result.data,
        count: result.data.length
      };
    } catch (e) {
      console.error('获取免费设备列表失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 获取当前离线设备列表
  if (action === 'getOfflineDevices') {
    try {
      const result = await db.collection('devices')
        .where({ isOnline: false })
        .field({
          deviceId: true,
          internalNo: true,
          deviceAddress: true,
          isOnline: true
        })
        .orderBy('updatedAt', 'desc')
        .get();

      return {
        success: true,
        data: result.data,
        count: result.data.length
      };
    } catch (e) {
      console.error('获取离线设备列表失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  return { error: 'unknown action' }
}
