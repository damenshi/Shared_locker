const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const fs = require('fs');

const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').filter(Boolean);


const batchCreateLockers = async (event) => {
  const { internalNo, deviceAddress, deviceDeposit, unitPrice, delayedRefund, screenNo,cabinetCount, lockersPerCabinet } = event

  // 验证参数
  if (!internalNo || !deviceAddress || deviceDeposit === undefined || unitPrice === undefined || !screenNo || !cabinetCount || !lockersPerCabinet) {
    return {
      success: false,
      errMsg: '请指定设备ID、设备地址、设备收费标准、收费策略、屏幕编号、锁板数量和每个锁板的锁数量'
    }
  }

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
          delayedRefund: delayedRefund || false,
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
      // 已存在，更新证书内容
      const updateData = {
        updatedAt: db.serverDate()
      };
      // 如果数据库中的值为空，但文件存在，则更新
      if (!existing.data[0].privateKey && privateKey) {
        updateData.privateKey = privateKey;
      }
      if (!existing.data[0].publicCert && publicCert) {
        updateData.publicCert = publicCert;
      }
      // 如果环境变量有值，更新配置
      if (process.env.MCHID_YH && process.env.MCHID_YH !== existing.data[0].mchid) {
        updateData.mchid = process.env.MCHID_YH;
      }
      if (process.env.MERCHANT_SERIAL_NO_YH && process.env.MERCHANT_SERIAL_NO_YH !== existing.data[0].merchantSerialNo) {
        updateData.merchantSerialNo = process.env.MERCHANT_SERIAL_NO_YH;
      }
      if (process.env.WX_API_V3_KEY_YH && process.env.WX_API_V3_KEY_YH !== existing.data[0].apiv3Key) {
        updateData.apiv3Key = process.env.WX_API_V3_KEY_YH;
      }

      if (Object.keys(updateData).length > 1) {
        await db.collection('merchant_configs').doc('yh').update({ data: updateData });
        return { success: true, message: '商户配置已更新' };
      }
      return { success: true, message: '商户配置已存在且无需更新' };
    }

    // 插入默认商户配置
    await db.collection('merchant_configs').add({
      data: {
        _id: 'yh',
        name: '珊星设备',
        mchid: process.env.MCHID_YH || '',
        merchantSerialNo: process.env.MERCHANT_SERIAL_NO_YH || '',
        apiv3Key: process.env.WX_API_V3_KEY_YH || '',
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
      // 已存在，更新
      const updateData = { updatedAt: db.serverDate() };
      if (!existing.data[0].privateKey && privateKey) updateData.privateKey = privateKey;
      if (!existing.data[0].publicCert && publicCert) updateData.publicCert = publicCert;
      if (process.env.MCHID_XYH) updateData.mchid = process.env.MCHID_XYH;
      if (process.env.MERCHANT_SERIAL_NO_XYH) updateData.merchantSerialNo = process.env.MERCHANT_SERIAL_NO_XYH;
      if (process.env.WX_API_V3_KEY_XYH) updateData.apiv3Key = process.env.WX_API_V3_KEY_XYH;

      if (Object.keys(updateData).length > 1) {
        await db.collection('merchant_configs').doc('xyh').update({ data: updateData });
        return { success: true, message: '第二个商户配置已更新' };
      }
      return { success: true, message: '第二个商户配置已存在且无需更新' };
    }

    // 插入第二个商户配置
    await db.collection('merchant_configs').add({
      data: {
        _id: 'xyh',
        name: '珊星智能存储',
        mchid: process.env.MCHID_XYH || '',
        merchantSerialNo: process.env.MERCHANT_SERIAL_NO_XYH || '',
        apiv3Key: process.env.WX_API_V3_KEY_XYH || '',
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

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()

  // 初始化商户配置不需要管理员权限
  if (action === 'initMerchantConfig') {
    return await initMerchantConfig();
  }

  // 初始化第二个商户配置（XYH珊星智能存储）
  if (action === 'initSecondMerchant') {
    return await initSecondMerchant();
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
            await db.collection('orders')
              .where({ _id: _.in(orderIds) })
              .update({
                data: {
                  status: '已强制结束',
                  endAt: db.serverDate(),
                  updatedAt: db.serverDate(),
                  note: '管理员一键清柜强制结束'
                }
              });
            totalOrders += orderIds.length;
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

  // 验证管理员权限
  console.log("OPENID:", OPENID);
  const isAdmin = ADMIN_OPENIDS.includes(OPENID)
  if (!isAdmin) {
    return { success: false, errMsg: '没有管理员权限' }
  }

  // 管理员权限验证接口
  if (action === 'amIAdmin') {
    return { isAdmin: true }
  }

  // 批量创建储物柜
  if (action === 'batchCreateLockers') {
    return await batchCreateLockers(event)
  }

  if (action === 'adminPermission'){
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

  // 获取所有商户配置
  if (action === 'getMerchantConfigs') {
    try {
      const merchants = await db.collection('merchant_configs')
        .orderBy('order', 'asc')
        .field({
          privateKey: false,  // 不返回私钥
          publicCert: false   // 不返回证书
        })
        .get();
      return { success: true, data: merchants.data };
    } catch (e) {
      console.error('获取商户配置失败:', e);
      return { success: false, errMsg: e.message };
    }
  }

  // 切换激活商户
  if (action === 'switchMerchant') {
    const { merchantId } = event;

    if (!merchantId) {
      return { success: false, errMsg: '缺少商户ID' };
    }

    try {
      // 验证目标商户是否存在
      const targetMerchant = await db.collection('merchant_configs').doc(merchantId).get();
      if (!targetMerchant.data || targetMerchant.data.length === 0) {
        return { success: false, errMsg: '商户不存在' };
      }

      // 事务：取消所有商户激活状态，设置目标商户为激活
      await db.runTransaction(async (transaction) => {
        // 1. 取消所有商户的激活状态
        await transaction.collection('merchant_configs')
          .where({ isActive: true })
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

  return { error: 'unknown action' }
}
