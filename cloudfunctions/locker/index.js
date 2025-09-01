const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { action } = event
  
  // 1. 查询空闲柜子（严格过滤无订单关联的柜子）
  if (action === 'listFree') {
    try {
      const lockerResult = await db.collection('lockers')
        .where({ 
          status: 'free',
          currentOrderId: _.eq(null)  // 仅返回无关联订单的空闲柜子
        })
        .field({
          _id: true,
          cabinetNo: true,
          size: true,
          status: true,
          currentOrderId: true
        })
        .get();
      return { success: true, data: lockerResult.data };
    } catch (err) {
      return { success: false, errMsg: '查询空闲柜子失败：' + err.message };
    }
  }
  
  // 2. 开门操作（核心逻辑）
  if (action === 'openDoor') {
    console.log('=== 开始执行开柜操作 ===');
    console.log('openDoor 接收的参数：', event);
    const { cabinetNo, orderId, type } = event;
    
    // 参数校验
    if (cabinetNo === undefined || cabinetNo === null) {
      return { ok: false, errMsg: '参数错误：cabinetNo不能为空' };
    }
    if (typeof cabinetNo !== 'number') {
      return { ok: false, errMsg: `参数错误：cabinetNo应为数字，实际是${typeof cabinetNo}` };
    }
    if (!orderId || orderId.trim() === '') {
      return { ok: false, errMsg: '参数错误：orderId不能为空或空字符串' };
    }
    if (!['store', 'take'].includes(type)) {
      return { ok: false, errMsg: '参数错误：type必须为"store"或"take"' };
    }

    try {
      console.log('开始事务处理，柜号：', cabinetNo);

      return await db.runTransaction(async transaction => {
        const lockerQuery = await transaction.collection('lockers')
          .where({ cabinetNo: cabinetNo })
          .get({
            readFresh: true
          });

        if (lockerQuery.data.length === 0) {
          throw new Error(`柜号 ${cabinetNo} 不存在`);
        }
        const locker = lockerQuery.data[0];
        const lockerId = locker._id;

        // 存包开柜逻辑
        if (type === 'store') {
          // 双重校验柜子状态
          if (locker.status !== 'occupied' || locker.currentOrderId !== orderId) {
            throw new Error(`存包失败：柜号 ${cabinetNo} 状态异常（当前：${locker.status}，关联订单：${locker.currentOrderId}）`);
          }
          
          // 验证订单已关联当前柜号
          const orderQuery = await transaction.collection('orders').doc(orderId).get();
          if (!orderQuery.data) {
            throw new Error(`订单 ${orderId} 不存在`);
          }
          // 校验订单状态为"已支付/进行中"（确保已完成支付）
          if (!['进行中', '已支付'].includes(orderQuery.data.status)) {
            throw new Error(`订单 ${orderId} 未支付，无法开柜`);
          }
          // 校验订单关联的柜号与当前开柜柜号一致
          if (orderQuery.data.cabinetNo !== cabinetNo) {
            throw new Error(`订单 ${orderId} 关联柜号不匹配（订单关联：${orderQuery.data.cabinetNo}，当前开柜：${cabinetNo}）`);
          }

          // 模拟硬件开柜
          const openSuccess = true;
          if (!openSuccess) {
            throw new Error(`柜号 ${cabinetNo} 硬件开柜失败`);
          }

          // 更新柜子状态为占用
          await transaction.collection('lockers').doc(lockerId).update({
            data: {
              status: 'occupied',
              currentOrderId: orderId,
              lastOpenAt: Date.now(),
              updatedAt: Date.now()
            }
          });

          // 更新订单关联的柜子
          await transaction.collection('orders').doc(orderId).update({
            data: {
              cabinetNo: cabinetNo,
              updatedAt: Date.now()
            }
          });

          return { ok: true, message: `存包成功，柜号 ${cabinetNo} 已打开`, cabinetNo: cabinetNo };
        }

        // 取包开柜逻辑
        if (type === 'take') {
          if (locker.status !== 'occupied') {
            throw new Error(`取包失败：柜号 ${cabinetNo} 状态异常（当前：${locker.status}，需：occupied）`);
          }
          if (locker.currentOrderId !== orderId) {
            throw new Error(`取包失败：柜号 ${cabinetNo} 与订单不匹配（当前关联：${locker.currentOrderId}，传入：${orderId}）`);
          }

          const openSuccess = true;
          if (!openSuccess) {
            throw new Error(`柜号 ${cabinetNo} 开门失败`);
          }

          await transaction.collection('lockers').doc(lockerId).update({
            data: {
              status: 'free',
              currentOrderId: null,
              lastOpenAt: Date.now(),
              updatedAt: Date.now()
            }
          });

          return { ok: true, message: `取包成功，柜号 ${cabinetNo} 已打开`, cabinetNo: cabinetNo };
        }
      });
    } catch (err) {
      console.error('=== 开柜操作失败（分类日志） ===');
      console.error('柜号：', cabinetNo);
      console.error('订单ID：', orderId);
      console.error('错误信息：', err.message);
      console.error('错误堆栈：', err.stack);
      
      // 存包失败时尝试恢复柜子状态
      if (type === 'store') {
        try {
          const locker = await db.collection('lockers').where({ cabinetNo }).get();
          if (locker.data.length > 0) {
            await db.collection('lockers').doc(locker.data[0]._id).update({
              data: {
                status: 'free',
                currentOrderId: null,
                updatedAt: Date.now()
              }
            });
            console.log(`柜号 ${cabinetNo} 已自动恢复为空闲状态`);
          }
        } catch (recoverErr) {
          console.error('存包失败后恢复柜子状态失败：', recoverErr);
        }
      }
      
      // 取包失败时尝试恢复柜子状态
      if (type === 'take') {
        try {
          const locker = await db.collection('lockers').where({ cabinetNo }).get();
          if (locker.data.length > 0 && locker.data[0].status === 'occupied') {
            await db.collection('lockers').doc(locker.data[0]._id).update({
              data: {
                status: 'free',
                currentOrderId: null,
                updatedAt: Date.now()
              }
            });
            return { ok: false, errMsg: err.message + '，已自动释放柜子' };
          }
        } catch (recoverErr) {
          console.error('自动恢复柜子状态失败：', recoverErr);
        }
      }
      return { ok: false, errMsg: err.message };
    }
  }
  
  // 3. 更新柜子状态（带自动恢复逻辑）
  if (action === 'updateStatus') {
    const { lockerId, status, orderId } = event;
    
    // 校验状态值
    if (!['free', 'occupied'].includes(status)) {
      return { success: false, errMsg: '状态错误：必须是"free"（空闲）或"occupied"（占用）' };
    }
    if (!lockerId) {
      return { success: false, errMsg: 'lockerId不能为空' };
    }

    try {
      // 如果是标记为占用状态，需要记录订单ID
      const updateData = { 
        status: status, 
        updatedAt: Date.now()
      };
      
      if (status === 'occupied') {
        if (!orderId) {
          throw new Error('标记为占用状态时，orderId不能为空');
        }
        updateData.currentOrderId = orderId;
      } else {
        // 空闲状态时清空订单ID
        updateData.currentOrderId = null;
      }

      await db.collection('lockers').doc(lockerId).update({ 
        data: updateData
      });
      return { success: true, message: `柜状态已更新为${status}` };
    } catch (err) {
      // 更新状态失败时，如果是尝试标记为占用，自动恢复为空闲
      if (status === 'occupied') {
        try {
          await db.collection('lockers').doc(lockerId).update({
            data: {
              status: 'free',
              currentOrderId: null,
              updatedAt: Date.now()
            }
          });
          return { success: false, errMsg: err.message + '，已自动恢复为空闲状态' };
        } catch (recoverErr) {
          console.error('恢复状态失败：', recoverErr);
        }
      }
      return { success: false, errMsg: '更新状态失败：' + err.message };
    }
  }
  
  // 4. 订单创建失败时的状态恢复专用接口
  if (action === 'recoverLocker') {
    const { cabinetNo } = event;
    if (typeof cabinetNo !== 'number') {
      return { success: false, errMsg: 'cabinetNo必须为数字' };
    }

    try {
      const locker = await db.collection('lockers')
        .where({ cabinetNo: cabinetNo })
        .get();
      
      if (locker.data.length > 0) {
        await db.collection('lockers').doc(locker.data[0]._id).update({
          data: {
            status: 'free',
            currentOrderId: null,
            updatedAt: Date.now()
          }
        });
        return { success: true, message: `柜号 ${cabinetNo} 已恢复为空闲状态` };
      } else {
        return { success: false, errMsg: `未找到柜号${cabinetNo}的记录` };
      }
    } catch (err) {
      return { success: false, errMsg: '恢复柜子状态失败：' + err.message };
    }
  }
  
  // 5. 根据柜号查询ID
  if (action === 'getByIdByNo') {
    const { cabinetNo } = event;
    
    if (typeof cabinetNo !== 'number') {
      return { success: false, errMsg: 'cabinetNo必须为数字' };
    }

    try {
      const res = await db.collection('lockers').where({ cabinetNo: cabinetNo }).get();
      if (res.data.length > 0) {
        return { success: true, lockerId: res.data[0]._id, data: res.data[0] };
      } else {
        return { success: false, errMsg: `未找到柜号${cabinetNo}的记录` };
      }
    } catch (err) {
      return { success: false, errMsg: '查询柜号失败：' + err.message };
    }
  }
  
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
}
