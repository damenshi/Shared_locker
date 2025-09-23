const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const axios = require('axios')

// 数据库引用
const db = cloud.database();
const devicesCollection = db.collection('devices');
const _ = db.command;

// 云函数主入口
exports.main = async (event, context) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const { type, deviceId, data} = body;
    console.log(`收到WebSocket转发消息:`, event);

    try {
        // 根据消息类型分发处理
        switch (type) {
            // 1. 设备登录请求处理
            case 'device_login_request':
                return handleDeviceLogin(deviceId);
                
            // 2. 设备心跳消息处理
            case 'device_heartbeat':
                return handleDeviceHeartbeat(deviceId);
                
            // 3. 手机号密码开门请求
            case 'open_by_phone_request':
                return handleOpenByPhone(deviceId, data);
            
            // 4. 设备离线通知
            case 'device_offline':
                return handleDeviceOffline(deviceId);
            // 4. 手机号开门结果反馈
            // case 'open_by_phone_result':
            //     return handleOpenByPhoneResult(deviceId, data);
                
            // 5. 开门结果反馈
            // case 'open_door_result':
            //     return handleOpenDoorResult(deviceId, data);
                
            // 6. 柜门状态更新
            // case 'door_status_result':
            //     return handleDoorStatusUpdate(deviceId, data);
                
            
                
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

async function startOfflineCheckTask() {
  const _ = db.command; // 确保引入数据库命令对象
  const checkInterval = 60 * 1000; // 1分钟检查一次
  const offlineThreshold = 5 * 60 * 1000; // 5分钟阈值

  setInterval(async () => {
      try {
          const fiveMinutesAgo = new Date(Date.now() - offlineThreshold);
          
          // 查询超过5分钟未心跳且在线的设备
          const offlineDevices = await devicesCollection
              .where({
                  isOnline: true,
                  updatedAt: _.lt(fiveMinutesAgo)
              })
              .get();

          if (offlineDevices.data.length > 0) {
              // 批量更新离线状态
              await devicesCollection
                  .where({
                      deviceId: _.in(offlineDevices.data.map(d => d.deviceId))
                  })
                  .update({
                      isOnline: false,
                      updatedAt: db.serverDate()
                  });

              console.log(`已标记 ${offlineDevices.data.length} 个设备为离线`);
          }
      } catch (error) {
          console.error('设备离线检查任务失败:', error);
      }
  }, checkInterval);
}

/**
 * 1. 处理设备登录请求
**/

let cachedToken = null;
let tokenExpireTime = 0;
/**
 * 获取微信小程序 access_token
 * @returns {Promise<string>} access_token
 */
async function getAccessToken() {
    const now = Date.now();

    // 如果缓存的 token 仍然有效，直接返回
    if (cachedToken && now < tokenExpireTime) {
        return cachedToken;
    }

    const APPID = 'wxc447a8e66f5f8294';
    const APPSECRET = '5b41ba2cdb527822e2e43c2fbb2a9db9';

    try {
        const res = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
            params: {
                grant_type: 'client_credential',
                appid: APPID,
                secret: APPSECRET
            }
        });

        const data = res.data;

        if (!data.access_token) {
            throw new Error('获取 access_token 失败: ' + JSON.stringify(data));
        }

        // 缓存 token，并提前1分钟刷新
        cachedToken = data.access_token;
        tokenExpireTime = now + (data.expires_in - 60) * 1000;

        console.log('[微信access_token] 获取成功', cachedToken);
        return cachedToken;
    } catch (err) {
        console.error('[微信access_token] 获取失败', err.message);
        throw err;
    }
}

async function ensureCounterDoc() {
  const docRef = db.collection('counters').doc('deviceCounter');
  try {
    const res = await docRef.get();
    if (!res.data) {
      // 文档不存在，创建初始文档
      await docRef.set({ internalNoSeq: 0 });
    }
  } catch (err) {
    // 如果 get 报错（文档不存在），也创建
    await docRef.set({ internalNoSeq: 0 });
  }
}

async function generateInternalNumber() {
  const counterDocId = 'deviceCounter';
  const MAX_RETRIES = 20; // 更多重试次数（模拟长队列）
  let retryCount = 0;
  const BASE_DELAY = 200; // 基础延迟稍大，给前一个事务足够时间完成

  while (retryCount < MAX_RETRIES) {
    try {
      return await db.runTransaction(async transaction => {
        const counterDocRef = transaction.collection('counters').doc(counterDocId);
        let counterRes;

        try {
          counterRes = await counterDocRef.get();
        } catch (err) {
          await counterDocRef.set({ data: { internalNoSeq: 1 } });
          return 'L0001';
        }

        const currentSeq = counterRes.data?.internalNoSeq || 0;
        const newSeq = currentSeq + 1;
        await counterDocRef.update({ data: { internalNoSeq: newSeq } });
        return 'L' + String(newSeq).padStart(4, '0');
      });
    } catch (err) {
      if (err.message.includes('TransactionConflict') && retryCount < MAX_RETRIES - 1) {
        retryCount++;
        // 延迟随重试次数线性增长，模拟排队等待时间
        // 公式：基础延迟 × (重试次数) → 让后到的请求等更久
        const delay = BASE_DELAY * retryCount; 
        console.log(`冲突，排队等待 ${delay}ms 后重试（第${retryCount}次）`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('最终失败：', err);
        throw new Error('编号生成失败，请稍后重试');
      }
    }
  }
}
    


async function generateUrlLink(deviceId) {
  const accessToken = await getAccessToken(); // 获取微信 access_token

  // 生成 URL Link 请求
  const res = await axios.post(
    `https://api.weixin.qq.com/wxa/generate_urllink?access_token=${accessToken}`,
    {
      // 跳转的小程序页面
      path: 'pages/index/index',
      // 携带参数，等价于小程序中 onLoad(options)
      query: `deviceId=${deviceId}`,
      // 可选配置：比如有效期、是否生成短链等
      is_expire: false
    }
  );

  if (res.data.url_link) {
    return res.data.url_link;
  } else {
    console.error('生成 URL Link 失败:', res.data);
    throw new Error(res.data.errmsg || 'generateUrlLink failed');
  }
}

async function handleDeviceLogin(deviceId) {
    // 查询设备是否已注册
    const deviceRes = await devicesCollection
        .where({ deviceId })
        .limit(1)
        .get();
    
    let urlLink;
    let internalNo;
    console.log('deviceRes:',deviceRes);
    if (deviceRes.data.length === 0) {
        // 设备未注册
        internalNo = await generateInternalNumber();
        // urlLink = await generateUrlLink(deviceId);//上线版可用
        urlLink = '体验版暂无';
        await devicesCollection.add({
          data: {
              deviceId: deviceId,       // 终端提供的设备ID
              internalNo: internalNo,
              cabinetCount: 0,
              doorCount: 0,
              deviceAddress:null,
              isOnline: true,           // 新注册设备默认在线
              isConfigured: false,
              urlLink: urlLink,
              lastLoginTime: db.serverDate(), // 记录登录时间
              createdAt: db.serverDate(),  // 创建时间
              updatedAt: db.serverDate()
          }
      });
      console.log(`设备 ${deviceId}已自动完成注册`);
    }else{
      // 更新设备在线状态
      urlLink = deviceRes.data[0].urlLink;
      internalNo = deviceRes.data[0].internalNo;
      await devicesCollection
      .where({ deviceId })
      .update({
        data: {
          isOnline: true,
          lastLoginTime: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
    console.log('internalNo:', internalNo);
    console.log('urlLink:', urlLink);
    // 返回设备二维码
    return {
        code: 200,
        data: {
          number: internalNo,
          url: urlLink
        }
    };
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
  const { phone, password, time } = data;
  
  // 1. 验证订单信息
  const orderRes = await db.collection('orders')
      .where({
          phone,
          password,
          status: '进行中', // 有效订单
          deviceId // 订单关联的设备ID
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
              type: 'take' // 取件操作类型
          }
      });

      // 3. 处理开柜结果
      if (openResult.result?.ok) {
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
              message: '手机号或密码错误', 
          };
      }
  } catch (error) {
      console.error('调用开柜函数失败:', error);
      return {
          code: 500,
          message: 'opendoor unsuccess'
      };
  }
}

/**
 * 4. 处理手机号开门结果反馈
 */
async function handleOpenByPhoneResult(deviceId, data) {
    const { doorSort, status } = data;
    
    // 更新订单状态（如果开门成功）
    if (status === 'success') {
        await db.collection('orders')
            .where({ doorSort, deviceId, status: 'valid' })
            .update({
                status: 'opened',
                openedAt: db.serverDate()
            });
    }
  
    return { code: 200, message: '开门结果已记录' };
}

/**
 * 5. 处理开门结果反馈
 */
async function handleOpenDoorResult(deviceId, data) {
    const { doorSort, time, status } = data;
    
    // 更新储物柜状态
    await lockersCollection
        .where({ deviceId, doorSort })
        .update({
            status: status === 'success' ? 'occupied' : 'fault',
            lastOpenAt: time,
            updatedAt: db.serverDate()
        });

    await logsCollection.add({
        deviceId,
        type: 'open_door',
        data: { doorSort, time, status },
        createdAt: db.serverDate()
    });

    return { code: 200, message: '开门结果已处理' };
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

startOfflineCheckTask();