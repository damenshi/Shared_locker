const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const axios = require('axios')

// 数据库引用
const db = cloud.database();
const devicesCollection = db.collection('devices');
const miniProgramsCollection = db.collection('mini_programs');
const _ = db.command;

const CONFIG = {
  appsecret: process.env.APPSECRET,
  appid: process.env.APPID,
};

// locker_server 地址
const LOCKER_SERVER_URL = process.env.LOCKER_SERVER_URL || 'http://1.116.109.239:3000';

// 从 locker_server 获取全局唯一编号
async function getInternalNoFromServer() {
    try {
        const res = await axios.get(`${LOCKER_SERVER_URL}/generateInternalNo`, { timeout: 5000 });
        if (res.data?.code === 200 && res.data?.data?.internalNo) {
            console.log('[编号生成] 从 locker_server 获取:', res.data.data.internalNo);
            return res.data.data.internalNo;
        }
        throw new Error('locker_server 返回无效数据');
    } catch (err) {
        console.error('[编号生成] 从 locker_server 获取失败:', err.message);
        // 降级：使用本地计数器（备用方案）
        throw err;
    }
}

// 获取当前最大编号（供 locker_server 初始化用）
async function getMaxInternalNo() {
    try {
        const res = await devicesCollection
            .orderBy('internalNo', 'desc')
            .limit(1)
            .get();

        if (res.data.length > 0 && res.data[0].internalNo) {
            // 解析 L0001 -> 1
            const match = res.data[0].internalNo.match(/L(\d+)/);
            if (match) {
                return parseInt(match[1]);
            }
        }
    } catch (e) {
        console.error('[getMaxInternalNo] 查询失败:', e);
    }
    return 0;
}

// 云函数主入口
exports.main = async (event, context) => {
    let body;
    try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
    } catch (e) {
        console.error('解析 body 失败:', e.message);
        return { code: 400, message: 'Invalid body format' };
    }
    const { type, deviceId, data, targetAppid } = body;
    console.log(`收到WebSocket转发消息:`, event);

    try {
        // 根据消息类型分发处理
        switch (type) {
            // 1. 设备登录请求处理
            case 'device_login_request':
                return handleDeviceLogin(deviceId, targetAppid);

            // 1.5 预创建设备（用于切换归属）
            case 'pre_create_device':
                return handlePreCreateDevice(deviceId, data);

            // 2. 设备心跳消息处理
            case 'device_heartbeat':
                return handleDeviceHeartbeat(deviceId);

            // 3. 手机号密码开门请求
            case 'open_by_phone_request':
                return handleOpenByPhone(deviceId, data);

            // 4. 设备离线通知
            case 'device_offline':
                return handleDeviceOffline(deviceId);

            // 5.中途手机号密码开门
            case 'mid_way_open_door':
                return handleMidwayOpen(deviceId, data);

            // 6. 获取最大编号（供 locker_server 初始化）
            case 'get_max_internal_no':
                const maxSeq = await getMaxInternalNo();
                return { code: 200, data: { maxSeq } };

            // 未知类型处理
            default:
                return {
                    code: 400,
                    message: `未知消息类型: ${type}`
                };
        }
    } catch (error) {
        console.error('云函数处理失败:', error);
        return {
            code: 500,
            message: error.message || '服务器处理失败'
        };
    }
};


/**
 * 1. 处理设备登录请求
**/

// 按 appid 缓存 token
const tokenCache = new Map();

/**
 * 从 mini_programs 获取小程序配置
 * @param {string} appid - 小程序 appid
 * @returns {Promise<object|null>} 小程序配置
 */
async function getMiniProgramConfig(appid) {
    try {
        const res = await miniProgramsCollection
            .where({ appid: appid, isActive: true })
            .limit(1)
            .get();
        return res.data.length > 0 ? res.data[0] : null;
    } catch (e) {
        console.error(`[获取小程序配置] appid=${appid} 失败:`, e.message);
        return null;
    }
}

/**
 * 获取微信小程序 access_token
 * @param {string} appid - 小程序 appid
 * @returns {Promise<string>} access_token
 */
async function getAccessToken(appid) {
    const now = Date.now();
    const targetAppid = appid || CONFIG.appid;

    // 如果缓存的 token 仍然有效，直接返回
    const cached = tokenCache.get(targetAppid);
    if (cached && now < cached.expireTime) {
        console.log(`[微信access_token] 使用缓存 appid=${targetAppid}`);
        return cached.token;
    }

    // 从 mini_programs 获取 appsecret
    let APPSECRET = CONFIG.appsecret; // 默认值
    const miniProgram = await getMiniProgramConfig(targetAppid);
    if (miniProgram && miniProgram.appsecret) {
        APPSECRET = miniProgram.appsecret;
        console.log(`[微信access_token] 从 mini_programs 获取 appid=${targetAppid} 的 appsecret`);
    } else if (targetAppid === CONFIG.appid) {
        // 如果是默认 appid，使用环境变量
        APPSECRET = CONFIG.appsecret;
    } else {
        throw new Error(`缺少 appid=${targetAppid} 的 appsecret，请检查 mini_programs 配置`);
    }

    try {
        const res = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
            params: {
                grant_type: 'client_credential',
                appid: targetAppid,
                secret: APPSECRET
            }
        });

        const data = res.data;

        if (!data.access_token) {
            throw new Error('获取 access_token 失败: ' + JSON.stringify(data));
        }

        // 缓存 token，并提前1分钟刷新
        tokenCache.set(targetAppid, {
            token: data.access_token,
            expireTime: now + (data.expires_in - 60) * 1000
        });

        console.log(`[微信access_token] 获取成功 appid=${targetAppid}`);
        return data.access_token;
    } catch (err) {
        console.error(`[微信access_token] 获取失败 appid=${targetAppid}`, err.message);
        throw err;
    }
}

async function generateUrlLink(deviceId, appid) {
  const accessToken = await getAccessToken(appid); // 使用设备对应的 appid 获取 access_token

  // 生成 URL Link 请求
  const res = await axios.post(
    `https://api.weixin.qq.com/wxa/generate_urllink?access_token=${accessToken}`,
    {
      // 跳转的小程序页面
      path: `pages/index/index`,
      // 携带参数，等价于小程序中 onLoad(options)
      query: `deviceId=${deviceId}`,
      // 可选配置：比如有效期、是否生成短链等
      is_expire: false
    }
  );

  if (res.data.url_link) {
    console.log(`[URL Link] 生成成功 deviceId=${deviceId}, appid=${appid}`);
    return res.data.url_link;
  } else {
    console.error('[URL Link] 生成失败:', res.data);
    throw new Error(res.data.errmsg || 'generateUrlLink failed');
  }
}

async function handleDeviceLogin(deviceId, targetAppid) {
    const currentAppid = process.env.APPID;

    // 检查路由是否正确（如果指定了 targetAppid）
    if (targetAppid && targetAppid !== currentAppid) {
        console.log(`[设备登录] 路由错误: deviceId=${deviceId}, target=${targetAppid}, current=${currentAppid}`);
        return { code: 301, message: '设备归属其他小程序' };
    }

    // 查询设备是否已注册
    const deviceRes = await devicesCollection
        .where({ deviceId })
        .limit(1)
        .get();

    console.log('deviceRes:', deviceRes);

    let internalNo;
    let deviceData;

    if (deviceRes.data.length === 0) {
        // 新设备：从 locker_server 获取全局唯一编号
        console.log(`[设备登录] 新设备，从 locker_server 获取编号: ${deviceId}`);
        internalNo = await getInternalNoFromServer();

        // 生成当前小程序的 URL Link
        const urlLink = await generateUrlLink(deviceId, currentAppid);

        // 创建设备记录
        deviceData = {
            deviceId: deviceId,
            internalNo: internalNo,
            appid: currentAppid,
            cabinetCount: 0,
            doorCount: 0,
            deviceAddress: null,
            isOnline: true,
            isConfigured: false,
            deviceDeposit: 0,
            urlLink: urlLink,
            screenNo: 0,
            lastLoginTime: db.serverDate(),
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
        };

        await devicesCollection.add({ data: deviceData });
        console.log(`[设备登录] 新设备注册成功: ${deviceId}, ${internalNo}`);
    } else {
        // 已有设备
        deviceData = deviceRes.data[0];
        internalNo = deviceData.internalNo;

        // 重新生成 URL Link（使用当前小程序的 appid）
        const urlLink = await generateUrlLink(deviceId, currentAppid);

        // 更新在线状态和 URL
        await devicesCollection.where({ deviceId }).update({
            data: {
                isOnline: true,
                urlLink: urlLink,
                appid: currentAppid,  // 更新 appid（可能从其他小程序迁移过来）
                lastLoginTime: db.serverDate(),
                updatedAt: db.serverDate()
            }
        });
        console.log(`[设备登录] 设备登录成功: ${deviceId}, ${internalNo}`);
    }

    return {
        code: 200,
        data: {
            number: internalNo,
            url: deviceData?.urlLink || await generateUrlLink(deviceId, currentAppid),
            appid: currentAppid
        }
    };
}

// 处理预创建设备（用于切换归属时）
async function handlePreCreateDevice(deviceId, data) {
    const { deviceData } = data || {};

    if (!deviceData || !deviceData.internalNo) {
        return { code: 400, message: '缺少 deviceData 或 internalNo' };
    }

    // 检查设备是否已存在
    const existRes = await devicesCollection.where({ deviceId }).get();
    if (existRes.data.length > 0) {
        console.log(`[预创建] 设备已存在: ${deviceId}`);
        return { code: 200, message: '设备已存在' };
    }

    // 创建新记录（使用传入的编号）
    await devicesCollection.add({
        data: {
            deviceId: deviceId,
            internalNo: deviceData.internalNo,
            appid: process.env.APPID,
            cabinetCount: deviceData.cabinetCount || 0,
            doorCount: deviceData.doorCount || 0,
            deviceAddress: deviceData.deviceAddress || null,
            screenNo: deviceData.screenNo || 0,
            isOnline: false,  // 预创建时为离线，等登录后变在线
            isConfigured: false,
            deviceDeposit: 0,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
        }
    });

    console.log(`[预创建] 设备预创建成功: ${deviceId}, ${deviceData.internalNo}`);
    return { code: 200, message: '预创建成功' };
}


/**
 * 2. 处理设备心跳消息
 * 更新设备最后活跃时间
 */
async function handleDeviceHeartbeat(deviceId, data, timestamp) {
    await devicesCollection
        .where({ deviceId })
        .update({
          data: {
            isOnline: true,
            updatedAt: db.serverDate()
          }
        });

    return { code: 200, message: 'heartbeat recv' };
}

/**
 * 3. 处理手机号密码开门请求
 * 验证手机号和密码是否匹配有效订单
 */
async function handleOpenByPhone(deviceId, data) {
  const {phone, password} = data;

  // 1. 先查询当前设备信息，看是否是从设备
  let searchDeviceId = deviceId;
  try {
    const devRes = await db.collection('devices').where({ deviceId }).get();
    if (devRes.data.length > 0) {
      const deviceData = devRes.data[0];
      // 如果存在 masterId，说明是从设备，需要去查主设备的订单
      if (deviceData.masterId) {
        searchDeviceId = deviceData.masterId;
        console.log(`[handleOpenByPhone] 检测到从设备 ${deviceId}，切换查询主设备 ${searchDeviceId} 的订单`);
      }
    }
  } catch (e) {
    console.error('查询设备信息失败', e);
    // 查询失败时继续尝试用原ID查，或者直接报错视业务而定
  }

  // 1. 验证订单信息
  const orderRes = await db.collection('orders')
      .where({
          phone,
          password,
          status: '进行中', // 有效订单
          deviceId: searchDeviceId //使用映射后的 ID (主设备ID) 查单
      })
      .limit(1)
      .get();

  if (orderRes.data.length === 0) {
      return { code: 500, message: '手机号或密码错误' };
  }

  const order = orderRes.data[0];
  
  // 2. 调用locker云函数的openDoor方法开柜
  try {
      const openResult = await cloud.callFunction({
          name: 'locker',
          data: {
              action: 'openDoor',
              deviceId: deviceId, //传入用户所在的物理设备ID，确保开对门
              doorNo: order.doorNo,
              orderId: order._id,
              cabinetNo: order.cabinetNo,
              type: 'take' // 取件操作类型
          }
      });

      // 3. 处理开柜结果
      if (openResult.result?.success) {

          const orderFinishRes = await cloud.callFunction({
            name: "order",
            data: {
              action: "finishOrder",
              orderId: order._id
            }
          });
          const isOrderFinished = orderFinishRes.result.success
          if(!isOrderFinished)
            throw new Error('OpenByPhone 订单结束失败');

          // 生成doorSort返回格式
          const cabinetNoStr = String(order.cabinetNo).padStart(2, '0');
          const doorNoStr = String(order.doorNo).padStart(2, '0');
          const doorSort = cabinetNoStr + doorNoStr;

          return {
              code: 200,
              data: {
                  doorSort: doorSort,
              }
          };
      } else {
          return {
              code: 500,
              message: '开柜失败', 
          };
      };

  } catch (error) {
      console.error('调用开柜函数失败:', error);
      return {
          code: 500,
          message: '开柜失败'
      };
  }
}

/**
 * 3. 处理手机号密码中途开门请求
 * 验证手机号和密码是否匹配有效订单
 */
async function handleMidwayOpen(deviceId, data) {
  const {phone, password} = data;

  let searchDeviceId = deviceId;
  try {
    const devRes = await db.collection('devices').where({ deviceId }).get();
    if (devRes.data.length > 0) {
      const deviceData = devRes.data[0];
      if (deviceData.masterId) {
        searchDeviceId = deviceData.masterId;
        console.log(`[handleMidwayOpen] 检测到从设备 ${deviceId}，切换查询主设备 ${searchDeviceId} 的订单`);
      }
    }
  } catch (e) {
    console.error('查询设备信息失败', e);
  }

  // 1. 验证订单信息
  const orderRes = await db.collection('orders')
      .where({
          phone,
          password,
          status: '进行中', // 有效订单
          deviceId: searchDeviceId //使用映射后的 ID 查单
      })
      .limit(1)
      .get();

  if (orderRes.data.length === 0) {
      return { code: 500, message: '手机号或密码错误' };
  }

  const order = orderRes.data[0];
  
  // 2. 调用locker云函数的openDoor方法开柜
  try {
      const openResult = await cloud.callFunction({
          name: 'locker',
          data: {
              action: 'openDoor',
              deviceId: deviceId,
              doorNo: order.doorNo,
              orderId: order._id,
              cabinetNo: order.cabinetNo,
              type: 'store' // 存件操作类型
          }
      });

      // 3. 处理开柜结果
      if (openResult.result?.success) {
          // 生成doorSort返回格式
          const cabinetNoStr = String(order.cabinetNo).padStart(2, '0');
          const doorNoStr = String(order.doorNo).padStart(2, '0');
          const doorSort = cabinetNoStr + doorNoStr;

          return {
              code: 200,
              data: {
                  doorSort: doorSort,
              }
          };
      } else {
          return {
              code: 500,
              message: '中途开柜失败', 
          };
      };

  } catch (error) {
      console.error('调用中途开柜函数失败:', error);
      return {
          code: 500,
          message: '中途开柜失败'
      };
  }
}

/**
 * 6. 处理柜门状态更新
 */
async function handleDoorStatusUpdate(deviceId, data) {
    const { doorSort, status, time } = data;
    
    // 更新柜门状态（free/occupied/fault）
    await lockersCollection
        .where({ deviceId, doorSort })
        .update({
            status,
            lastStatusChange: time,
            updatedAt: db.serverDate()
        });

    await logsCollection.add({
        deviceId,
        type: 'door_status',
        data: { doorSort, status, time },
        createdAt: db.serverDate()
    });

    return { code: 200, message: '柜门状态已更新' };
}

/**
 * 7. 处理设备离线通知
 */
async function handleDeviceOffline(deviceId) {
    // 更新设备离线状态
    await devicesCollection
        .where({ deviceId })
        .update({
            data: {
              isOnline: false,
              updatedAt: db.serverDate()
            }
        });
      return { code: 200, message: '设备离线已确认' };
}
