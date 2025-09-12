# 共享储物柜小程序（示例完整代码）

> 适用于微信云开发（TCB）环境，包含：下单/支付（模拟）、开门、订单列表/详情、异常处理、计费规则管理、营收统计（示例）。

## 快速开始

1. 在 **微信开发者工具** 新建云开发小程序，把本项目解压后导入。
2. 在云开发控制台开通环境，复制 `envId`，修改 `miniprogram/config.js` 中的 `envId`。
3. 右键 `cloudfunctions` 目录 -> **一键上传并部署**（选中所有函数，安装依赖）。
4. 在**数据库**中新建集合：`users`, `orders`, `lockers`, `stats`。
6. **支付说明**：示例使用“模拟支付”，不调用微信支付。接入正式支付请在 `cloudfunctions/payOrder/` 内对接商户号/统一下单等流程。
7. **开门说明**：示例在 `openDoor` 函数中模拟。若有实际物联网柜，请在该函数中调用你的设备HTTP/MQTT API。

> 管理员鉴权：把你的 `openid` 加入 `cloudfunctions/common/admin.js` 中的 `ADMIN_OPENIDS` 即可看到管理页面与操作按钮。

