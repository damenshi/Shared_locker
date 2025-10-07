// cloudfunctions/user/index.js
const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV // 使用当前环境
});
const db = cloud.database();
const _ = db.command;

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

  const wxContext = cloud.getWXContext();
  const { action , openid, phone} = event;

  if (action === 'getOpenid') {
    return {
      success: true,
      openid: wxContext.OPENID,
    };
  }

  if (action === 'getUserInfo') {
    try {
      const userRes = await db.collection('users')
        .where({ openid: openid })
        .get();

      if (userRes.data.length === 0) {
        throw new Error('获取用户信息失败');
      }

      return {
        success: true,
        data: userRes.data[0],
      };
    } catch (error) {
      console.error('获取用户信息失败', {error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  if (action === 'createUser') {
    try {
      return await db.runTransaction(async transaction => {
          // 先查询用户是否已存在
          const existingUser = await transaction.collection('users')
            .where({ openid: openid})
            .get();

          if (existingUser.data.length > 0) {
            const user = await transaction.collection('users')
            .where({ openid: openid})
            .update({
              data: {
                phone,
                updatedAt: db.serverDate()
              }
            });
          }else{
            const user = await transaction.collection('users').add({
              data: {
                phone,
                openid: openid,
                deposit: 0,
                isAdmin: false,
                createdAt: db.serverDate(),
                updatedAt: db.serverDate()
              }
            });
          }

          const updatedUser = await transaction.collection('users')
          .where({ openid: openid })
          .get();

          if (updatedUser.data.length === 0) {
            throw new Error('无有效用户');
          }

          const user = updatedUser.data[0];
          return { success: true, data: user };
        })
      } catch (error) {
        return {
          success: false, errMsg: '创建用户失败：' + error.message
        };
      }

  }

  if (action === 'getDeposit') {
    try {
      const userRes = await db.collection('users')
        .where({ openid: openid })
        .get();
      if (userRes.data.length === 0)
        throw new Error('获取余额失败');

      return {
        success: true,
        data: userRes.data[0].deposit,
      };
    } catch (error) {
      return {
        success: false,
        errMsg: '获取用户余额失败：' + error.message
      };
    }
  }

  if(action === 'updateUser'){
    const {openid, deposit} = event

    // 参数校验
    const validation = validateParams(event, {
      openid: { type: 'string' },
    })
    if (!validation.valid) {
      return { ok: false, errMsg: validation.msg }
    }

    try {
      return await db.runTransaction(async transaction => {
        // 获取订单
        const userDoc = await transaction.collection('users').where({openid:openid}).get()
        if (!userDoc.data) {
          throw new Error('用户不存在')
        }

        // 更新数据
        const updateData = { updatedAt: db.serverDate() }
        // if (typeof phone !== 'undefined') {
        //   updateData.phone = phone
        // }
        if (typeof deposit !== 'undefined') {
          updateData.deposit = deposit + userDoc.data[0].deposit
        }

        // 更新订单
        await transaction.collection('users').where({openid:openid}).update({
          data: updateData
        })

        return { success: true }
      })
    } catch (err) {
      console.error('更新用户信息失败', {error: err.message })
      return { success: false, errMsg: err.message }
    }
  }

  if (action === 'refundDeposit') {
    const {openid} = event;
    try {
      return await db.runTransaction(async transaction => {
        // 1. 查询用户信息及余额
        const userRes = await transaction.collection('users')
          .where({ openid: openid })
          .get();

        if (userRes.data.length === 0) {
          throw new Error('用户不存在');
        }

        const user = userRes.data[0];
        const currentDeposit = user.deposit || 0;

        // 2. 验证余额是否充足
        if (currentDeposit <= 0) {
          throw new Error('余额不足');
        }

        let actualRefundAmount = currentDeposit; // 默认全额退款
        // 4. 执行退款（更新余额）
        await transaction.collection('users')
          .where({ openid: openid })
          .update({
            data: {
              deposit: _.inc(-actualRefundAmount), // 减少余额
              updatedAt: db.serverDate(),
            }
          });

        return {
          success: true,
          message: '退款成功'
        };
      })
    } catch (error) {
      return {
        success: false,
        message: '退款失败：' + error.message
      };
    }
  }
  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
};