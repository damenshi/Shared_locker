const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 常量定义：集中管理固定值
const CONSTANTS = {
  LOCKER_STATUSES: ['free', 'occupied', 'broken'], // 柜子允许的状态
  OPERATION_TYPES: ['store', 'take']     // 允许的操作类型
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



exports.main = async (event, context) => {
  const { action } = event

  // 1. 查询空闲柜子
  if (action === 'listFree') {
    try {
      const { deviceId } = event;
      
      //拦截从设备存包请求 ===
      // 1. 获取设备信息
      const devRes = await db.collection('devices').where({ deviceId }).get();
      if (devRes.data.length > 0) {
        const device = devRes.data[0];
        // 2. 如果存在 masterId，说明这是取包面（从设备）
        if (device.masterId) {
           return { 
             success: false, 
             errMsg: '此处为取包口，请前往柜子正面（存包区）进行存包' 
           };
        }
      }

      return await db.runTransaction(async transaction => {
        const whereCondition = {
          status: 'free',
          currentOrderId: _.eq(null),
          deviceId: deviceId
        };
  
        // 1. 查询一个空闲柜子
        const lockerRes = await transaction.collection('lockers')
          .where(whereCondition)
          .get();
  
        if (lockerRes.data.length === 0) {
          throw new Error('没有可用柜子');
        }
  
        // const locker = lockerRes.data[0];
        const randomIndex = Math.floor(Math.random() * lockerRes.data.length);
        const locker = lockerRes.data[randomIndex];

        // 2. 更新为占用
        await transaction.collection('lockers').doc(locker._id).update({
          data: {
            status: 'occupied',
            updatedAt: db.serverDate()
          }
        });
  
        // 3. 返回占用的柜子信息
        return { success: true, data: locker };
      });
  
    } catch (err) {
      console.error('占用柜子失败', err);
      return { success: false, errMsg: `占用柜子失败：${err.message}` };
    }

  }

  // 2. 开门操作
  if (action === 'openDoor') {
    console.log('=== 执行开柜操作 ===', event)
    const { deviceId, doorNo, orderId, cabinetNo, type} = event

    // 参数校验
    const validation = validateParams(event, {
      deviceId: {type: 'string'},
      doorNo: { type: 'number' },
      orderId: { type: 'string' },
      type: { enum: CONSTANTS.OPERATION_TYPES },
      cabinetNo: { type: 'number' } 
    })
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    // P0优化: 指令结果查询接口
    const queryCommandResult = async (requestId, maxRetries = 3) => {
      const axios = require('axios');
      let attempt = 0;
      while (attempt < maxRetries) {
        try {
          attempt++;
          const queryRes = await axios.get(
            `http://1.116.109.239:3000/command-result/${requestId}`,
            { timeout: 5000 }
          );
          if (queryRes.data.code === 200) {
            return { success: true, data: queryRes.data.data };
          }
          if (queryRes.data.code === 202) {
            // 仍在处理中，等待后重试
            console.log(`[查询指令] requestId=${requestId}, 第${attempt}次查询，指令处理中，等待1秒`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          // 408超时 或 404不存在
          return { success: false, message: queryRes.data.message };
        } catch (err) {
          console.warn(`[查询指令] requestId=${requestId}, 第${attempt}次查询异常: ${err.message}`);
          if (attempt >= maxRetries) {
            return { success: false, message: err.message };
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      return { success: false, message: '查询超时' };
    };

    const callHardwareOpen = async (deviceId, cabinetNo, doorNo, maxRetries = 1) => {
      let attempt = 0;

      // 延迟函数
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      while (attempt < maxRetries) {
        try {
          attempt++;

          // 2. 调用socket服务器接口
          const formatNumber = (num) => {
            return num.toString().padStart(2, '0');
          };
          const formattedCabinetNo = formatNumber(cabinetNo);
          const formattedDoorNo = formatNumber(doorNo);
          const combinedCode = formattedCabinetNo + formattedDoorNo;

          const axios = require('axios');
          const response = await axios.post(
            'http://1.116.109.239:3000/send-command',
            {
              direct: 'openDoor',
              deviceId: deviceId,
              data: {
                doorSort: combinedCode,
              }
            },
            { timeout: 10000 }
          );

          // 成功条件
          if (response.data.code === 200 && response.data.doorSort == combinedCode) {
            return true;
          }

          // P0优化: 202响应处理 - 使用相同的requestId查询结果
          if (response.data.code === 202) {
            const existingRequestId = response.data.requestId;
            console.warn(`[202响应] deviceId=${deviceId}, doorSort=${combinedCode}, requestId=${existingRequestId}, 等待后查询结果`);

            // 使用相同的requestId查询结果
            const queryRes = await queryCommandResult(existingRequestId, 5);
            if (queryRes.success) {
              console.log(`[202查询成功] deviceId=${deviceId}, doorSort=${combinedCode}, requestId=${existingRequestId}`);
              return true;
            }

            // P1优化: 只有"不存在/已过期"时才重发指令，其他继续轮询
            if (queryRes.message === '指令不存在或已过期') {
              console.warn(`[202查询] deviceId=${deviceId}, requestId=${existingRequestId}, 指令已过期，重新发送`);
              await delay(2000);
              continue;
            }
            // 其他情况（查询超时、指令处理中）继续轮询
            console.warn(`[202查询] deviceId=${deviceId}, requestId=${existingRequestId}, ${queryRes.message}，继续等待`);
            await delay(2000);
            continue;
          }

          console.warn(`第 ${attempt} 次返回非200, 准备重试`);

          // 最后一次仍非200 → 按原逻辑抛错
          if (attempt >= maxRetries) {
            // 这里的 response.data.code 就是你服务器返回的业务错误码（如 500）
            throw new Error(`服务器返回错误: ${response.data.code} ${response.data.message || '未知错误'}`)
          }

        } catch (err) {
          console.warn(`第 ${attempt} 次请求异常: ${err.message}`);

          // 最后一次失败才走原有错误处理逻辑
          if (attempt >= maxRetries) {
            if (err.code === 'ECONNABORTED') {
                throw new Error(`连接超时，请检查服务器是否在线`);
            }

            if (err.response) {
                // 优先取 response.data.code (业务码)，取不到才用 response.status (HTTP码)
                const businessCode = err.response.data?.code || err.response.status;
                const errorMsg = err.response.data?.message || err.response.statusText;
                console.error(`服务器返回错误: 设备${deviceId}，业务码${businessCode}，HTTP码${err.response.status}，message: ${errorMsg}`);

                // 这样抛出去就是 "服务器返回错误: 500 设备 xxx 不在线"
                // paynotify 就能正确识别并取消订单了
                throw new Error(`服务器返回错误: ${businessCode} ${errorMsg}`);
            }
            throw new Error(`开柜接口调用失败: ${err.message}`);
          }
        }

        // 等待时间递增：500ms * 2^(attempt-1)
        const waitTime = 200 * Math.pow(2, attempt - 1);
        console.log(`等待 ${waitTime}ms 后进行第 ${attempt + 1} 次尝试...`);
        await delay(waitTime);
      }
    };
    
    try {
      // 查询当前设备
      const devRes = await db.collection('devices').where({ deviceId }).get();
      const currentDevice = devRes.data[0] || {};
      
      // 判断是否是从设备
      const isSlave = !!currentDevice.masterId;
      
      // dataLockerId: 数据存储在哪个设备名下？(如果有masterId，则数据在masterId名下)
      const dataLockerId = isSlave ? currentDevice.masterId : deviceId;
      
      // targetHardwareId: 发指令给哪个设备？(发给用户当前扫码的设备)
      const targetHardwareId = deviceId;

        // 查询柜子信息
        const lockerQuery = await db.collection('lockers')
          .where({ 
                  deviceId: dataLockerId, 
                  doorNo, 
                  cabinetNo
                })
          .get({ readFresh: true })

        if (lockerQuery.data.length === 0) {
          throw new Error(`柜门 ${cabinetNo}_${doorNo} 不存在`)
        }

        const locker = lockerQuery.data[0]
        const lockerId = locker._id
        const now = Date.now()

        // 存包开柜逻辑
        if (type === 'store') {

          // 状态校验
          if (locker.status !== 'occupied' || locker.currentOrderId !== orderId) {
            throw new Error(
              `存包失败：柜门 ${locker.lockerNo} 状态异常（当前：${locker.status}，关联订单：${locker.currentOrderId}）`
            )
          }

          //硬件开柜
          const openSuccess = await callHardwareOpen(targetHardwareId, cabinetNo, doorNo);
          if (!openSuccess) {
            throw new Error(`柜门 ${targetHardwareId}_${cabinetNo}_${doorNo} 硬件开柜失败`)
          }

          return { 
            success: true, 
            message: `存包成功，柜门 ${targetHardwareId}_${cabinetNo}_${doorNo} 已打开`
          }
        }

        // 取包开柜逻辑
        if (type === 'take') {
          // 状态校验
          if (locker.status !== 'occupied' || locker.currentOrderId !== orderId) {
            throw new Error(
              `取包失败：柜门 ${targetHardwareId}_${cabinetNo}_${doorNo} 与订单不匹配（当前关联：${locker.currentOrderId}，传入：${orderId}）`
            )
          }

          // 模拟硬件开柜
          const openSuccess = await callHardwareOpen(targetHardwareId, cabinetNo, doorNo);
          if (!openSuccess) {
            throw new Error(`柜门 ${deviceId}_${cabinetNo}_${doorNo} 硬件开柜失败`)
          }

          // 更新柜子状态为空闲
          // 更新的是 dataLockerId (主设备) 的记录
          await db.collection('lockers').doc(lockerId).update({
            data: {
              status: 'free',
              currentOrderId: null,
              currentUserPhone: null,
              lastOpenAt: db.serverDate(),
              updatedAt: db.serverDate()
            }
          })

          // 3. 后端强制结束订单，不再依赖前端调用 finishOrder
          try {
              await cloud.callFunction({
                name: 'order',
                data: {
                    action: 'finishOrder',
                    orderId: orderId
                }
              });
              console.log(`订单 ${orderId} 自动结算成功`);
          } catch(err) {
              // 即使结算发生异常，也要记录日志，但不能影响用户开门拿走东西
              console.error(`订单 ${orderId} 自动结算失败，需人工核实:`, err);
          }
  
          return { 
            success: true, 
            message: `取包成功，柜门 ${deviceId}_${cabinetNo}_${doorNo} 已打开`
          }
        }

    } catch (err) {
      console.error('开柜操作失败', {
        deviceId,
        doorNo,
        cabinetNo,
        orderId,
        message: err.message,
        stack: err.stack
      })

      return { success: false, errMsg: err.message }
    }
  }

  // 3. 更新柜子信息
  if (action === 'updateLocker') {
    const { lockerId, currentOrderId, currentUserPhone} = event

    // 参数校验
    const validation = validateParams(event, {
      lockerId: { type: 'string' },
    })
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    try {
        // 更新数据
        const updateData = { updatedAt: db.serverDate() }
        if (typeof currentOrderId !== 'undefined') {
          updateData.currentOrderId = currentOrderId
        }
        if (typeof currentUserPhone !== 'undefined') {
          updateData.currentUserPhone = currentUserPhone
        }
        // 更新柜子
        await db.collection('lockers').doc(lockerId).update({
          data: updateData
        })
  
        return { success: true }
    } catch (err) {
      console.error('更新柜子信息失败', { orderId, error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 4. 恢复柜子状态为空闲
  if (action === 'recoverLocker') {
    // 修复点：必须接收 orderId
    const { deviceId, doorNo, cabinetNo, orderId} = event

    // 参数校验
    const validation = validateParams(event, {
      deviceId: {type: 'string'},
      doorNo: { type: 'number' },
      cabinetNo: { type: 'number' },
      orderId: { type: 'string' } // 要求必传 orderId
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      // 修复点：使用单行 CAS 保护，绝不盲目清空柜子！
      // 只有当前柜子依然属于这个将要废弃的订单时，才允许清空。
      const res = await db.collection('lockers')
        .where({ 
          deviceId, 
          doorNo, 
          cabinetNo,
          currentOrderId: orderId  // 防止清空了别人或自己已经成功的订单
        })
        .update({
          data: {
            status: 'free',
            currentOrderId: null,
            currentUserPhone: null,
            updatedAt: db.serverDate()
          }
        });

      if (res.stats.updated === 0) {
         console.warn(`[恢复柜门拦截] 柜门已属于他人或已恢复，跳过清理`);
         return { success: false, errMsg: '跳过清理' };
      }

      return { success: true, message: `柜门 ${doorNo} 已安全恢复为空闲状态` }
    } catch (err) {
      console.error('恢复柜子状态失败', err)
      return { success: false, errMsg: `恢复柜子状态失败：${err.message}` }
    }
  }

  if (action === 'queryDoorStatus') {
    const { deviceId, cabinetNo, doorNo} = event;
    const validation = validateParams(event, {
      deviceId: {type: 'string'},
      doorNo: { type: 'number' },
      cabinetNo: { type: 'number' } 
    })
    if (!validation.valid) {
      return { success: false, errMsg: validation.msg }
    }

    try {
      const axios = require('axios');
      const formattedCabinetNo = String(cabinetNo).padStart(2, '0');
      const formattedDoorNo = String(doorNo).padStart(2, '0');
      const combinedCode = formattedCabinetNo + formattedDoorNo;
      const response = await axios.post(
        'http://1.116.109.239:3000/send-command', 
        {
          direct: 'doorStatus',
          deviceId: deviceId,
          data: {
            doorSort: combinedCode,
          }
        },
        { timeout: 8000 }  // 8秒超时设置
      );
      
      if (response.data.code !== 200 || response.data.doorSort != combinedCode) {
        throw new Error(`服务器响应异常`);
      }
      return {
        success: true,
        data: {
          status: response.data.status, // 字符串状态（'open'/'closed'等）
          doorNo,
          cabinetNo,
          deviceId
        }
      };
    }catch (err) {
      if (err.code === 'ECONNABORTED') {
        throw new Error(`连接超时，请检查服务器是否在线`);
      }
      if (err.response) {
        throw new Error(`服务器返回错误: ${err.response.status} ${err.response.statusText}`);
      }
    }
  }

  if (action === 'openDoorByAdmin') {
    console.log('=== 执行管理员开柜操作 ===', event)
    const { internalNo, lockerNo} = event

    // 参数校验
    const validation = validateParams(event, {
      internalNo: {type: 'string'},
      lockerNo: { type: 'number' }
    })
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    // P0优化: 指令结果查询接口 (管理员版本)
    const queryCommandResultAdmin = async (requestId, maxRetries = 3) => {
      const axios = require('axios');
      let attempt = 0;
      while (attempt < maxRetries) {
        try {
          attempt++;
          const queryRes = await axios.get(
            `http://1.116.109.239:3000/command-result/${requestId}`,
            { timeout: 5000 }
          );
          if (queryRes.data.code === 200) {
            return { success: true, data: queryRes.data.data };
          }
          if (queryRes.data.code === 202) {
            console.log(`[查询指令-Admin] requestId=${requestId}, 第${attempt}次查询，指令处理中，等待1秒`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          return { success: false, message: queryRes.data.message };
        } catch (err) {
          console.warn(`[查询指令-Admin] requestId=${requestId}, 第${attempt}次查询异常: ${err.message}`);
          if (attempt >= maxRetries) {
            return { success: false, message: err.message };
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      return { success: false, message: '查询超时' };
    };

    const callHardwareOpen = async (deviceId, cabinetNo, doorNo, maxRetries = 1) => {
      let attempt = 0;

      // 延迟函数
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      while (attempt < maxRetries) {
        try {
          attempt++;

          // 2. 调用socket服务器接口
          const formatNumber = (num) => {
            return num.toString().padStart(2, '0');
          };
          const formattedCabinetNo = formatNumber(cabinetNo);
          const formattedDoorNo = formatNumber(doorNo);
          const combinedCode = formattedCabinetNo + formattedDoorNo;

          const axios = require('axios');
          const response = await axios.post(
            'http://1.116.109.239:3000/send-command',
            {
              direct: 'openDoor',
              deviceId: deviceId,
              data: {
                doorSort: combinedCode,
              }
            },
            { timeout: 10000 }
          );

          // 成功条件
          if (response.data.code === 200 && response.data.doorSort == combinedCode) {
            return true;
          }

          // P0优化: 202响应处理 - 使用相同的requestId查询结果
          if (response.data.code === 202) {
            const existingRequestId = response.data.requestId;
            console.warn(`[202响应-Admin] deviceId=${deviceId}, doorSort=${combinedCode}, requestId=${existingRequestId}, 等待后查询结果`);

            const queryRes = await queryCommandResultAdmin(existingRequestId, 5);
            if (queryRes.success) {
              console.log(`[202查询成功-Admin] deviceId=${deviceId}, doorSort=${combinedCode}, requestId=${existingRequestId}`);
              return true;
            }

            // P1优化: 只有"不存在/已过期"时才重发指令，其他继续轮询
            if (queryRes.message === '指令不存在或已过期') {
              console.warn(`[202查询-Admin] deviceId=${deviceId}, requestId=${existingRequestId}, 指令已过期，重新发送`);
              await delay(2000);
              continue;
            }
            // 其他情况继续轮询
            console.warn(`[202查询-Admin] deviceId=${deviceId}, requestId=${existingRequestId}, ${queryRes.message}，继续等待`);
            await delay(2000);
            continue;
          }

          console.warn(`第 ${attempt} 次返回非200，准备重试`);

          // 最后一次仍非200 → 按原逻辑抛错
          if (attempt >= maxRetries) {
            throw new Error(`服务器响应异常: ${response.data.message || '未知错误'}`);
          }

        } catch (err) {
          console.warn(`第 ${attempt} 次请求异常: ${err.message}`);

          // 最后一次失败才走原有错误处理逻辑
          if (attempt >= maxRetries) {
            if (err.code === 'ECONNABORTED') {
              throw new Error(`连接超时，请检查服务器是否在线`);
            }
            if (err.response) {
              const errorMsg = err.response.data?.message || err.response.statusText;
              console.error(`服务器返回错误: 设备${deviceId}，状态码${err.response.status}，message: ${errorMsg}`);
              throw new Error(`服务器返回错误: ${err.response.status} ${errorMsg}`);
            }
            throw new Error(`开柜接口调用失败: ${err.message}`);
          }
        }

        // 等待时间递增：500ms * 2^(attempt-1)
        const waitTime = 200 * Math.pow(2, attempt - 1);
        console.log(`等待 ${waitTime}ms 后进行第 ${attempt + 1} 次尝试...`);
        await delay(waitTime);
      }
    };

    try {
        // 查询柜子信息
        const lockerQuery = await db.collection('lockers')
          .where({ internalNo, lockerNo})
          .get({ readFresh: true })

        if (lockerQuery.data.length === 0) {
          throw new Error(`设备${internalNo} 柜门${lockerNo}不存在`)
        }

        const locker = lockerQuery.data[0]
        // const lockerId = locker._id
        const deviceId = locker.deviceId
        const cabinetNo = locker.cabinetNo
        const doorNo = locker.doorNo

        //硬件开柜
        const openSuccess = await callHardwareOpen(deviceId, cabinetNo, doorNo);
        if (!openSuccess) {
          throw new Error(`柜门 ${deviceId}_${cabinetNo}_${doorNo} 硬件开柜失败`)
        }

        return { 
          success: true, 
          message: `开柜成功，柜门 ${deviceId}_${cabinetNo}_${doorNo} 已打开`
        }
    } catch (err) {
      console.error('开柜操作失败', {
        message: err.message,
        stack: err.stack
      })
      return { success: false, errMsg: err.message }
    }
  }

  if (action === 'getDevFreeDoor') {
    try {
      const { deviceId } = event;
  
      return await db.runTransaction(async transaction => {
        const whereCondition = {
          status: 'free',
          currentOrderId: _.eq(null),
          deviceId: deviceId
        };
  
        // 1. 查询一个空闲柜子
        const lockerRes = await transaction.collection('lockers')
          .where(whereCondition)
          .get();
  
        const freeCnt = lockerRes.data.length;
  
        // 3. 返回占用的柜子信息
        return { success: true, data: freeCnt };
      });
  
    } catch (err) {
      console.error('查询设备空闲柜门个数失败', err);
      return { success: false, errMsg: `查询设备空闲柜门个数失败${err.message}` };
    }
  }

  if (action === 'freeDoorByDev') {
    const { deviceId } = event

    // 参数校验
    const validation = validateParams(event, {
      deviceId: { type: 'string' },
    })
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    try {
        const deviceRes = await db.collection('devices').where({ deviceId }).get();
        const screenNo = deviceRes.data[0]?.screenNo || null;
        if (!screenNo) {
          throw new Error(`未找到设备的 screenNo, 无法执行释放操作`)
        }

        //先找出这台设备上所有身上带有遗留订单的柜门
        const occupiedLockers = await db.collection('lockers')
          .where({
            deviceId,
            lockerNo: _.neq(screenNo),
            status: _.neq('broken'),
            currentOrderId: _.neq(null) // 🎯 只找挂着订单的
          }).get();

        // 循环遍历，把遗留订单全部终结掉！
        for (const locker of occupiedLockers.data) {
          console.warn(`[管理员一键清柜] 设备${deviceId} 柜门${locker.lockerNo}释放，同步结束遗留订单: ${locker.currentOrderId}`);
          try {
            await cloud.callFunction({
              name: 'order',
              data: { action: 'forceFinish', orderId: locker.currentOrderId }
            });
          } catch(e) {
            console.error(`结束遗留订单 ${locker.currentOrderId} 失败`, e);
          }
        }

        // 释放该设备的所有柜门
        await db.collection('lockers')
          .where({
            deviceId,
            lockerNo: _.neq(screenNo),
            status: _.neq('broken')
          })
          .update({
            data: {
              status: 'free',
              currentOrderId: null,
              currentUserPhone: null,
              updatedAt: db.serverDate()
            }
          });
  
        return { success: true }
    } catch (err) {
      console.error('清空柜门失败', { error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  // 5. 管理员强制设置柜门状态（维护/测试模式）
  if (action === 'setLockerStatus') {
    const { internalNo, lockerNo, status } = event
    const validStatuses = ['free', 'broken', 'occupied'];
    if (!validStatuses.includes(status)) {
      return { success: false, errMsg: `状态无效，只能设为: ${validStatuses.join(' / ')}` }
    }

    try {
      // 1. 查询柜子
      const lockerQuery = await db.collection('lockers')
        .where({ internalNo, lockerNo })
        .get()

      if (lockerQuery.data.length === 0) {
        throw new Error(`设备${internalNo} 柜门${lockerNo}不存在`)
      }

      const locker = lockerQuery.data[0]

      // 2. 如果强制设为“空闲”或“故障”，必须处理遗留订单！
      // 必须在这里先处理，此时不占用数据库底层的读写锁
      if ((status === 'free' || status === 'broken') && locker.currentOrderId) {
        console.warn(`[管理员清柜] 柜门${lockerNo}状态变更为${status}，正在同步结束遗留订单: ${locker.currentOrderId}`);
        try {
          await cloud.callFunction({
            name: 'order',
            data: { action: 'forceFinish', orderId: locker.currentOrderId }
          });
        } catch(e) {
          console.error('强制结束遗留订单失败', e);
        }
      }

      // 3. 准备更新数据
      let updateData = {
        status: status,
        updatedAt: db.serverDate()
      };

      if (status === 'free') {
        updateData.currentOrderId = null;
        updateData.currentUserPhone = null;
      }

      // 4. 执行更新
      await db.collection('lockers').doc(locker._id).update({
        data: updateData
      })

      let statusText = '';
      switch (status) {
        case 'free': statusText = '启用(空闲)'; break;
        case 'broken': statusText = '停用(故障)'; break;
        case 'occupied': statusText = '占用(保留)'; break;
        default: statusText = status;
      }

      return { success: true, message: `柜门 ${lockerNo} 已设为 ${statusText}` }
    } catch (err) {
      console.error('设置柜门状态失败', err)
      return { success: false, errMsg: err.message }
    }
  }

  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}

