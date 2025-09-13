const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 数据库引用
const db = cloud.database();
const devicesCollection = db.collection('devices');

// 云函数主入口
exports.main = async (event, context) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const { type, deviceId, data, timestamp } = body;
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
                
            // 4. 手机号开门结果反馈
            // case 'open_by_phone_result':
            //     return handleOpenByPhoneResult(deviceId, data);
                
            // 5. 开门结果反馈
            // case 'open_door_result':
            //     return handleOpenDoorResult(deviceId, data);
                
            // 6. 柜门状态更新
            // case 'door_status_result':
            //     return handleDoorStatusUpdate(deviceId, data);
                
            // 7. 设备离线通知
            // case 'device_offline':
            //     return handleDeviceOffline(deviceId, timestamp);
                
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
 * 验证设备ID是否存在于数据库中
 */
async function handleDeviceLogin(deviceId, timestamp) {
    // 查询设备是否已注册
    const deviceRes = await devicesCollection
        .where({ deviceId })
        .limit(1)
        .get();

    if (deviceRes.data.length === 0) {
        // 设备未注册
        return {
            code: 404,
            message: `设备 ${deviceId} 未注册`
        };
    }

    // 更新设备在线状态
    await devicesCollection
        .where({ deviceId })
        .update({
          data: {
            isOnline: true,
            lastLoginTime: timestamp,
            updatedAt: db.serverDate()
          }
        });

    // 返回设备编号（可自定义生成规则）
    return {
        code: 200,
        data: {
          deviceId: deviceId
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
async function handleDeviceOffline(deviceId, timestamp) {
    // 更新设备离线状态
    await lockersCollection
        .where({ deviceId })
        .update({
            isOnline: false,
            lastOfflineTime: timestamp,
            updatedAt: db.serverDate()
        });

    await logsCollection.add({
        deviceId,
        type: 'offline',
        timestamp,
        createdAt: db.serverDate()
    });

    return { code: 200, message: '设备离线已记录' };
}

startOfflineCheckTask();