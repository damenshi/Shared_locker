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
        const existingUser = await db.collection('users').where({openid}).get();
        if (existingUser.data.length > 0) {
          const user = existingUser.data[0];
          await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: db.serverDate() } });
          user.phone = phone;
          return { success: true, data: user };
        } else {
          const addRes = await db.collection('users').add({ data: { phone, openid, deposit: 0, isAdmin: false, createdAt: db.serverDate(), updatedAt: db.serverDate() } });
          return { success: true, data: { _id: addRes._id, phone, openid, deposit: 0, isAdmin: false } };
        }
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
      const updateData = { updatedAt: db.serverDate() };
      if (typeof deposit !== 'undefined') {
        updateData.deposit = db.command.inc(deposit); // 累加 deposit
      }

      const res = await db.collection('users')
        .where({ openid })
        .update({ data: updateData });

      if (res.stats.updated === 0) {
        return { success: false, errMsg: '用户不存在或未更新' };
      }

      return { success: true };
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

        const order = orderRes.data;
        const client = getClient();
        const refundParams = {
          out_trade_no: order.outTradeNo || order._id, // 原商户订单号
          out_refund_no: `refund_${Date.now()}`, // 退款单号
          amount: {
            refund: refundAmount, // 退款金额(分)
            total: order.amount || refundAmount, // 原订单总金额
            currency: 'CNY'
          },
          notify_url: CONFIG.notify_url // 退款结果通知地址
        };

        const refundResult = await client.refunds(refundParams);
        if (refundResult.data.status !== 'SUCCESS') {
          throw new Error(`支付平台退款失败: ${refundResult.data.status}`);
        }

        await transaction.collection('users')
          .where({ openid: openid })
          .update({
            data: {
              deposit: _.inc(-refundAmount),
              updatedAt: db.serverDate()
            }
          });

        await transaction.collection('orders').doc(orderId).update({
          data: {
            refundStatus: '已退款',
            refundAmount,
            refundTime: db.serverDate(),
            refundId: refundResult.data.out_refund_no,
            updatedAt: db.serverDate()
          }
        });

        return {
          success: true,
          message: '退款成功',
          data: {
            refundAmount,
            refundNo: refundResult.data.out_refund_no
          }
        };
      })
    } catch (error) {
      console.error('退款处理失败:', error);
      return {
        success: false,
        message: `退款失败：${error.message}`
      };
    }
  }

  if(action === 'getPhone'){
    const {code} = event
    if (!code) return { error: '缺少 code' };

    try {
      const res = await cloud.openapi.user.getPhoneNumber({ code });
      // res.phoneInfo 里直接包含 phoneNumber
      return res;
    } catch (err) {
      console.error(err);
      return { error: err.message };
    }
  }

  // 未知操作
  return { error: 'unknown action', errMsg: '未找到对应的操作' }
};