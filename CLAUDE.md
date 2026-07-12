# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a WeChat Mini Program (微信小程序) for smart locker management called "珊星储物" (LockerShare). It provides a complete storage locker rental system with WeChat Pay integration, hardware control, and admin management.

**App ID**: `wxc447a8e66f5f8294`
**Cloud Environment**: `cloudbase-3gnr17whd71a5b45`

## Architecture

### Frontend (miniprogram/)
WeChat Mini Program with standard page-based architecture:
- **Pages**: home, index, store, take, admin/*, mine/*
- **Entry**: `app.js` initializes cloud environment and manages global state (openid, deviceId)
- **Config**: `config.js` contains cloud environment ID

### Backend (cloudfunctions/)
8 cloud functions handling different domains:

| Function | Purpose | Key Actions |
|----------|---------|-------------|
| `order` | Order lifecycle & payments | createOrder, finishOrder, refundOrder, createPrepay, getDeviceOrderStats |
| `locker` | Locker hardware operations | listFree, openDoor, recoverLocker, queryDoorStatus, setLockerStatus |
| `device` | Device management | getDevicesDeposit, getDeviceAddress, getDevices |
| `user` | User management | getOpenid, createUser, getDeposit, updateUser, getPhone |
| `server` | Hardware communication gateway | Handles WebSocket messages from locker hardware (device_login_request, open_by_phone_request, etc.) |
| `admin` | Admin operations | batchCreateLockers, adminPermission (requires ADMIN_OPENIDS env var) |
| `adminops` | Global settings | Toggle free mode for all devices |
| `paynotify` | Payment webhooks | Handles TRANSACTION.SUCCESS and REFUND.SUCCESS callbacks |

### Database Collections
- `devices` - Locker hardware devices (deviceId, internalNo, isOnline, unitPrice, delayedRefund, refundDelayHours, masterId)
- `lockers` - Individual locker doors (deviceId, cabinetNo, doorNo, status: free/occupied/broken, currentOrderId)
- `orders` - Rental orders (status: 待支付/进行中/已完成/已取消/已退款, deposit, refundAmount)
- `users` - User accounts (openid, phone, deposit balance, isAdmin)
- `counters` - Auto-increment counters (internalNoSeq)
- `admin_permission` - Admin role assignments

### Hardware Integration
Socket server at `http://1.116.109.239:3000/send-command` controls physical lockers:
- `openDoor` - Opens specified locker door
- `doorStatus` - Queries door open/closed status
- Door format: `{cabinetNo:02d}{doorNo:02d}` (e.g., "0105" = cabinet 1, door 5)

## Key Business Flows

### Storage Flow (存包)
1. User enters phone + 4-digit password on `pages/store/store`
2. System checks for existing "进行中" orders (forces completion if found)
3. `locker.listFree` assigns random free locker, marks as occupied
4. `order.createOrder` creates order with status "待支付"
5. If device `isFree=true`: skip payment, set status "进行中"
6. If payment required: `order.createPrepay` → WeChat Pay → `paynotify` webhook
7. `paynotify` calls `locker.openDoor` and updates order to "进行中"
8. User stores items

### Retrieval Flow (取包)
1. User enters phone + password on `pages/take/take`
2. `order.queryByOpenid` finds "进行中" order for this device
3. `locker.openDoor` with type="take" opens door and frees locker
4. `order.finishOrder` calculates fee (free 10 min, then hourly rate) and updates order
5. If `device.delayedRefund = true`: order status becomes "待提现" (withdrawable after `refundDelayHours` hours; `0` means immediately withdrawable)
6. Otherwise (`delayedRefund = false`): automatic WeChat refund for remaining deposit

### Master/Slave Device Pattern
Some devices have `masterId` field indicating they're secondary units:
- Orders are always stored under master device ID
- Slave devices query master's orders for phone/password unlock
- Physical door commands go to the actual device user is at

## Environment Variables (Cloud Functions)

Required environment variables configured in WeChat Cloud Console:
- `APPID` - WeChat Mini Program App ID
- `APPSECRET` - WeChat App Secret
- `MCHID_XYH` / `MCHID_YH` - WeChat Pay Merchant IDs
- `MERCHANT_SERIAL_NO_XYH` / `MERCHANT_SERIAL_NO_YH` - Merchant certificate serial numbers
- `WX_API_V3_KEY_XYH` / `WX_API_V3_KEY_YH` - WeChat Pay APIv3 keys
- `ADMIN_OPENIDS` - Comma-separated list of admin openids

## Payment Certificates

Cloud functions `order` and `paynotify` require certificate files in `cloudfunctions/order/private/`:
- `apiclient_cert_xyh.pem` / `apiclient_cert_yh.pem` - Merchant certificates
- `apiclient_key_xyh.pem` / `apiclient_key_yh.pem` - Private keys
- `pub_key_xyh.pem` / `pub_key_yh.pem` - WeChat Pay public keys

## Development Commands

### Deploy Cloud Functions
```bash
# Deploy specific function
wx cloud functions:deploy --name order --env cloudbase-3gnr17whd71a5b45

# Deploy all functions
wx cloud functions:deploy --all --env cloudbase-3gnr17whd71a5b45
```

### Install Dependencies
```bash
# For cloud function with npm dependencies
cd cloudfunctions/order
npm install
```

### Cloud Database Operations
Access via WeChat Developer Tools → Cloud Development → Database, or use wx CLI.

## Code Patterns

### Cloud Function Structure
All cloud functions follow this pattern:
```javascript
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// Parameter validation helper
const validateParams = (params, rules) => { ... }

exports.main = async (event, context) => {
  const { action } = event
  if (action === 'someAction') { ... }
  return { error: 'unknown action' }
}
```

### Order Status Constants
```javascript
const ORDER_STATUSES = {
  PENDING_PAY: '待支付',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  FORCE_FINISHED: '已强制结束',
  CANCELLED: '已取消',
  REFUNDED: '已退款'
}
```

### Fee Calculation Logic (in order cloud function)
- Free period: 10 minutes
- Billing: hourly rate (unitPrice) after free period
- Fee cannot exceed deposit
- refundAmount = deposit - fee

### Delayed Refund Flow

`device.delayedRefund` controls whether refunds go through the wallet/withdrawal flow, while `device.refundDelayHours` configures the withdrawal waiting time.

- `delayedRefund = false`: Refunds are returned directly to the original payment account.
- `delayedRefund = true`: Refunds enter the `"待提现"` status and must be withdrawn via `pages/mine/mywallet`.
  - `refundDelayHours = 0`: Immediately withdrawable after entering `"待提现"`.
  - `refundDelayHours = N`: Withdrawable after N hours.

When a refund enters `"待提现"`, the current `refundDelayHours` is snapshotted onto the order document so that existing pending withdrawals are not affected by later device configuration changes. `order.withdrawRefund` initiates the actual WeChat refund once the waiting period has passed.

## Important Implementation Details

1. **Transaction Safety**: Critical operations (locker assignment, payment) use `db.runTransaction()`

2. **Idempotency**: `paynotify` handles duplicate callbacks by checking current order status before processing

3. **Device Auto-Registration**: When hardware connects via `server` function, devices auto-register with generated internal number (L0001, L0002, etc.)

4. **URL Link Generation**: Each device gets a permanent QR code URL via WeChat's `generate_urllink` API

5. **Stats Obfuscation**: `getDeviceOrderStats` applies a discount formula to real order counts (displays ~85% of actual) for business purposes

6. **Error Handling Strategy**: In `paynotify`, only explicit 500 errors from hardware cause order cancellation; timeouts/soft errors are treated as success to prevent revenue loss

## Common Issues

- **Hardware timeout**: Socket server has 15s timeout; retry logic with exponential backoff in `locker.openDoor`
- **Transaction conflicts**: `server.generateInternalNumber` has retry logic for concurrent device registrations
- **Payment status sync**: `order.getOrder` proactively queries WeChat API if local status is "待支付" to catch missed callbacks

## Multi-Instance Deployment (多小程序实例部署)

This codebase supports multiple WeChat Mini Programs sharing the same source code.

### Instance Configuration Files

Each instance needs to configure:

| File | Fields to Modify |
|------|-----------------|
| `miniprogram/config.js` | `envId`, `appid` |
| `project.config.json` | `appid`, `projectname` |

See `miniprogram/config.example.js` for a configuration template.

### Deployment Steps for New Instance

1. Clone this repository to a new directory
2. Copy `config.example.js` to `config.js` and modify:
   ```javascript
   module.exports = {
     envId: 'your-cloud-environment-id',
     appid: 'your-miniprogram-appid'
   }
   ```
3. Update `project.config.json`:
   ```json
   {
     "appid": "your-miniprogram-appid",
     "projectname": "YourProjectName"
   }
   ```
4. Deploy cloud functions to your cloud environment via WeChat Developer Tools
5. Create required database collections in your cloud environment

### Required Database Collections

- `devices` - Device registration and status
- `lockers` - Locker door status
- `orders` - Order records
- `users` - User accounts
- `counters` - Auto-increment counters
- `merchant_configs` - Payment merchant configuration
- `mini_programs` - Mini program configuration
- `admin_permission` - Admin role assignments
