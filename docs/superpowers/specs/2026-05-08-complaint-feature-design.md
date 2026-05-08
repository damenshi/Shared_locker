# 用户投诉功能设计文档

## 上下文与背景

当前用户反馈渠道仅有客服电话（400-832-6132），无系统化的投诉记录和处理流程。当用户遇到退款失败、柜门打不开等问题时，只能电话联系，无法跟踪处理进度，管理员也无法集中管理和统计投诉。

本功能为用户提供一个内嵌的投诉通道，支持关联订单、分类投诉、跟踪处理状态；为管理员提供投诉管理平台，集中查看、回复和处理投诉。

## 设计目标

1. 用户在"我的"页面可直接查看/发起投诉
2. 每个订单均可一键发起投诉（自动带入订单信息）
3. 管理员在后台可查看全部投诉，进行状态流转和回复
4. 仅**超级管理员**（`type: 'super'`）有权管理投诉，设备管理员（`type: 'device'`）无权

## 数据模型

复用 `docs/complaints_schema.json` 设计，集合名 `complaints`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 系统自动生成 |
| `openid` | string | 用户openid |
| `phone` | string | 用户手机号 |
| `orderId` | string? | 关联订单ID（可选） |
| `deviceId` | string? | 设备ID（从订单自动带入） |
| `internalNo` | string? | 设备编号（从订单自动带入） |
| `lockerNo` | string? | 柜门号（从订单自动带入） |
| `type` | string | 投诉类型：`refund`\|`door`\|`other` |
| `typeText` | string | 类型中文文本 |
| `content` | string | 投诉描述（必填，最多500字） |
| `status` | string | 状态：`pending`\|`processing`\|`resolved`\|`rejected` |
| `statusText` | string | 状态中文文本 |
| `reply` | string? | 管理员回复 |
| `handledBy` | string? | 处理人openid |
| `handledAt` | Date? | 处理时间 |
| `createdAt` | Date | 创建时间 |
| `updatedAt` | Date | 更新时间 |

### 状态流转图

```
待处理(pending) --管理员接手--> 处理中(processing) --处理完成--> 已解决(resolved)
                                                     --无法处理--> 已拒绝(rejected)
```

## 用户端设计

### 入口位置

`pages/mine/mine` 页面：在"客服电话"菜单项上方增加"投诉与建议"入口。

### 页面1：投诉列表 (`pages/mine/complaintList`)

**布局：**
- 顶部："发起新投诉"按钮（醒目）
- 主体：投诉记录列表
- 每项卡片：投诉类型 + 状态标签 + 内容摘要 + 创建时间
- 点击卡片进入详情

**数据加载：**
- 调用 `complaint.getMyComplaints`
- 按 `createdAt desc` 排序

### 页面2：投诉详情 (`pages/mine/complaintDetail`)

**布局：**
- 投诉类型、状态（彩色标签）
- 关联订单信息（如有）
- 投诉内容
- 管理员回复（如有）
- 处理时间（如有）

### 页面3：提交投诉 (`pages/mine/complaintForm`)

**布局：**
- 投诉类型选择（单选）：退款问题 / 柜门打不开 / 其他
- 关联订单（可选）：如从订单页面进入，自动显示订单号
- 投诉内容（多行文本输入，必填，最多500字）
- 提交按钮

**数据来源：**
- 从订单页面进入：URL参数传入 `orderId`，自动查询订单详情预填
- 从我的页面直接发起：orderId 为空

### 订单页面入口 (`pages/mine/myorder`)

每个订单卡片底部增加"投诉"按钮（灰色小按钮，与退款按钮并排或在其下方）：
- 点击跳转 `complaintForm?orderId={{item._id}}`

## 管理员端设计

### 入口位置

`pages/admin/admin` 页面：在"系统设置"分组中或新增"投诉管理"卡片，与"商户管理"等并列。

### 页面：投诉管理 (`pages/admin/complaints`)

**权限控制：** 仅 `type: 'super'` 管理员可访问，设备管理员（`type: 'device'`）不可见。

**布局：**
- 顶部：状态筛选标签（全部 / 待处理 / 处理中 / 已解决 / 已拒绝）
- 主体：投诉列表
- 每项卡片：
  - 用户信息（手机号）
  - 投诉类型
  - 关联订单号
  - 内容摘要
  - 状态标签
  - 创建时间
  - 操作按钮："处理"（pending状态）/ "查看"（其他状态）

### 页面：投诉处理 (`pages/admin/complaintDetail`)

**布局：**
- 投诉详情（同用户端）
- 状态流转按钮组：
  - pending → processing（标记为处理中）
  - processing → resolved（标记为已解决）
  - processing → rejected（标记为已拒绝）
- 回复输入框 + 提交回复按钮

## 云函数API设计

新建 `cloudfunctions/complaint/index.js`，遵循现有 action 分发模式。

### `createComplaint`

**权限：** 任意登录用户
**参数：** `{ type, content, orderId? }`
**逻辑：**
1. 从 context 获取 openid
2. 验证参数：type 在枚举内，content 非空且长度 <= 500
3. 如传入 orderId，查询订单并验证归属（openid 匹配），自动带入 deviceId/internalNo/lockerNo/phone
4. 生成 typeText 和 statusText
5. 插入 complaints 集合
6. 返回 `{ success: true, data: { complaintId } }`

### `getMyComplaints`

**权限：** 任意登录用户
**参数：** 无（从 context 取 openid）
**逻辑：**
1. 查询 `complaints` where openid = 当前用户
2. 按 `createdAt desc` 排序
3. 返回列表

### `getComplaintList`

**权限：** 仅超级管理员
**参数：** `{ status? }`（可选，筛选状态）
**逻辑：**
1. 检查 `admin_permission` 表中当前 openid 的 type 是否为 `super`
2. 如传入 status，追加 where 条件
3. 按 `createdAt desc` 排序
4. 返回列表

### `getComplaintDetail`

**权限：** 用户可查看自己的，管理员可查看所有
**参数：** `{ complaintId }`
**逻辑：**
1. 查询投诉详情
2. 权限检查：如不是管理员且 openid 不匹配，拒绝
3. 返回详情

### `updateStatus`

**权限：** 仅超级管理员
**参数：** `{ complaintId, status }`
**逻辑：**
1. 检查超级管理员权限
2. 验证 status 在枚举内
3. 更新 status/statusText，如状态变为 processing/resolved/rejected，记录 handledBy/handledAt
4. 返回成功

### `addReply`

**权限：** 仅超级管理员
**参数：** `{ complaintId, reply }`
**逻辑：**
1. 检查超级管理员权限
2. 验证 reply 非空
3. 更新 reply、handledBy、handledAt
4. 返回成功

## 错误处理

- 参数验证失败：返回 `{ success: false, errMsg: '...' }`
- 权限不足：返回 `{ success: false, errMsg: '没有管理员权限' }`
- 投诉不存在：返回 `{ success: false, errMsg: '投诉记录不存在' }`
- 订单不属于当前用户：返回 `{ success: false, errMsg: '无权投诉此订单' }`

## 创建文件清单

| 文件 | 类型 |
|---|---|
| `cloudfunctions/complaint/index.js` | 新建 |
| `cloudfunctions/complaint/package.json` | 新建 |
| `miniprogram/pages/mine/complaintList.js` | 新建 |
| `miniprogram/pages/mine/complaintList.wxml` | 新建 |
| `miniprogram/pages/mine/complaintList.wxss` | 新建 |
| `miniprogram/pages/mine/complaintList.json` | 新建 |
| `miniprogram/pages/mine/complaintForm.js` | 新建 |
| `miniprogram/pages/mine/complaintForm.wxml` | 新建 |
| `miniprogram/pages/mine/complaintForm.wxss` | 新建 |
| `miniprogram/pages/mine/complaintForm.json` | 新建 |
| `miniprogram/pages/mine/complaintDetail.js` | 新建 |
| `miniprogram/pages/mine/complaintDetail.wxml` | 新建 |
| `miniprogram/pages/mine/complaintDetail.wxss` | 新建 |
| `miniprogram/pages/mine/complaintDetail.json` | 新建 |
| `miniprogram/pages/admin/complaints.js` | 新建 |
| `miniprogram/pages/admin/complaints.wxml` | 新建 |
| `miniprogram/pages/admin/complaints.wxss` | 新建 |
| `miniprogram/pages/admin/complaints.json` | 新建 |
| `miniprogram/pages/admin/complaintDetail.js` | 新建 |
| `miniprogram/pages/admin/complaintDetail.wxml` | 新建 |
| `miniprogram/pages/admin/complaintDetail.wxss` | 新建 |
| `miniprogram/pages/admin/complaintDetail.json` | 新建 |
| `miniprogram/app.json` | 修改（注册新页面） |
| `miniprogram/pages/mine/mine.wxml` | 修改（增加入口） |
| `miniprogram/pages/mine/mine.js` | 修改（增加导航方法） |
| `miniprogram/pages/mine/myorder.wxml` | 修改（增加投诉按钮） |
| `miniprogram/pages/mine/myorder.js` | 修改（增加导航方法） |
| `miniprogram/pages/admin/admin.wxml` | 修改（增加投诉管理入口） |
| `miniprogram/pages/admin/admin.js` | 修改（增加导航方法） |

## 验收标准

- [ ] 用户从"我的"页面点击"投诉与建议"可看到投诉列表和发起按钮
- [ ] 用户可从订单列表点击"投诉"按钮发起投诉（自动带入订单信息）
- [ ] 用户提交投诉后可在列表中看到，状态为"待处理"
- [ ] 超级管理员在后台可看到全部投诉，设备管理员看不到
- [ ] 管理员可将投诉标记为"处理中"、"已解决"或"已拒绝"
- [ ] 管理员可回复投诉，用户可在详情中看到回复
- [ ] 投诉详情页正确显示所有字段
