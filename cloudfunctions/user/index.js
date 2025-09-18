// cloudfunctions/user/index.js
const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV // 使用当前环境
});
const db = cloud.database();
const _ = db.command;

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
      if (userRes.data.length > 0) {
        return {
          success: true,
          data: userRes.data[0],
          message: '获取用户信息成功'
        };
      } else {
        return {
          success: false,
          message: '用户信息不存在'
        };
      }
    } catch (error) {
      return {
        success: false,
        message: '获取用户信息失败：' + error.message
      };
    }
  }

  if (action === 'createUser') {

    try {
      // 先查询用户是否已存在
      const existingUser = await db.collection('users')
        .where({ openid: openid})
        .get();

      if (existingUser.data.length > 0) {
        const user = await db.collection('users')
        .where({ openid: openid})
        .update({
          data: {
            phone,
            updatedAt: db.serverDate()
          }
        });
      }else{
        const user = await db.collection('users').add({
          data: {
            phone,
            openid: openid,
            deposit: 0,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        });
      }

      const updatedUser = await db.collection('users')
      .where({ openid: openid })
      .get();

      // 返回完整的用户数据（包含更新后的手机号）
      return {
        _id: updatedUser.data[0]._id,
        phone: updatedUser.data[0].phone, 
        deposit: updatedUser.data[0].deposit, 
        openid: updatedUser.data[0].openid
      };
    } catch (error) {
      return {
        message: '创建用户失败：' + error.message
      };
    }
  }

  if (action === 'getDeposit') {
    console.log("getDeposit openid:", openid)
    try {
      const userRes = await db.collection('users')
        .where({ openid: openid })
        .get();
      if (userRes.data.length > 0) {
        return {
          data: userRes.data[0],
          message: '获取用户信息成功'
        };
      } else {
        return {
          message: '用户信息不存在'
        };
      }
    } catch (error) {
      return {
        message: '获取用户信息失败：' + error.message
      };
    }
  }

  if (action === 'refundDeposit') {
    if (!openid) {
      return {
        success: false,
        message: '缺少openid参数'
      };
    }
    
    try {
      // 1. 查询用户信息及余额
      const userRes = await db.collection('users')
        .where({ openid: openid })
        .get();

      if (userRes.data.length === 0) {
        return {
          success: false,
          message: '用户不存在'
        };
      }

      const user = userRes.data[0];
      const currentDeposit = user.deposit || 0;
      console.log("user:", user);
      console.log("currentDeposit:", currentDeposit);
      // 2. 验证余额是否充足
      if (currentDeposit <= 0) {
        return {
          success: false,
          message: '用户余额为0，无需退款',
          currentDeposit
        };
      }

      let actualRefundAmount = currentDeposit; // 默认全额退款
      // 4. 执行退款（更新余额）
      await db.collection('users')
        .where({ openid: openid })
        .update({
          data: {
            deposit: _.inc(-actualRefundAmount), // 减少余额
            updatedAt: db.serverDate(),
          }
        });

      // 5. 查询更新后的用户信息
      // const updatedUser = await db.collection('users')
      //   .where({ openid: openid })
      //   .get();

      return {
        success: true,
        message: '退款成功',
        // refundAmount: actualRefundAmount,
        // remainingDeposit: updatedUser.data[0].deposit,
      };

    } catch (error) {
      return {
        success: false,
        message: '退款失败：' + error.message
      };
    }
  }
  // 未知操作
  return {
    code: 400,
    message: `未知操作：${action}`
  };
};