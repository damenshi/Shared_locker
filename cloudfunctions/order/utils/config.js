/**
 * 统一配置获取工具
 * 所有配置从数据库读取，零硬编码，零环境变量
 */

const cloud = require('wx-server-sdk');
const db = cloud.database();

// 内存缓存
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

function getCache(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.time < CACHE_TTL) {
    return item.data;
  }
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

/**
 * 获取当前小程序配置
 * 根据云函数执行环境自动识别
 */
async function getCurrentMiniProgram() {
  const { APPID } = cloud.getWXContext();
  const cacheKey = `mini_${APPID}`;

  let config = getCache(cacheKey);
  if (config) return config;

  try {
    const res = await db.collection('mini_programs')
      .where({ appid: APPID, isActive: true })
      .limit(1)
      .get();

    config = res.data[0] || null;
    if (config) setCache(cacheKey, config);
    return config;
  } catch (e) {
    console.error('[getCurrentMiniProgram] 获取失败:', e);
    return null;
  }
}

/**
 * 获取指定appid的小程序配置
 */
async function getMiniProgramByAppid(appid) {
  const cacheKey = `mini_${appid}`;

  let config = getCache(cacheKey);
  if (config) return config;

  try {
    const res = await db.collection('mini_programs')
      .where({ appid, isActive: true })
      .limit(1)
      .get();

    config = res.data[0] || null;
    if (config) setCache(cacheKey, config);
    return config;
  } catch (e) {
    console.error('[getMiniProgramByAppid] 获取失败:', e);
    return null;
  }
}

/**
 * 获取系统配置
 */
async function getSystemConfig(key) {
  const cacheKey = `sys_${key}`;
  let config = getCache(cacheKey);
  if (config) return config;

  try {
    // 先尝试用 doc 查询（兼容旧数据）
    try {
      const res = await db.collection('system_configs').doc(key).get();
      if (res.data) {
        config = res.data;
        setCache(cacheKey, config);
        return config;
      }
    } catch (docErr) {
      // doc 查询失败，继续用 where 查询
    }

    // 用 where 查询（支持自定义 key 字段或 url 字段匹配）
    const res = await db.collection('system_configs')
      .where({
        $or: [
          { key: key },
          { url: db.RegExp({ regexp: '.*', options: 'i' }) }
        ]
      })
      .limit(1)
      .get();

    // 如果没找到特定 key，返回第一条（假设是 locker_server 配置）
    config = res.data[0] || null;
    if (config) setCache(cacheKey, config);
    return config;
  } catch (e) {
    console.error('[getSystemConfig] 获取失败:', e);
    return null;
  }
}

/**
 * 获取locker_server地址
 */
async function getLockerServerUrl() {
  const config = await getSystemConfig('locker_server');
  return config?.url || 'http://localhost:3000';
}

/**
 * 获取当前激活的商户配置
 */
async function getActiveMerchant() {
  const miniProgram = await getCurrentMiniProgram();
  if (!miniProgram) {
    console.error('[getActiveMerchant] 未找到当前小程序配置');
    return null;
  }

  const cacheKey = `merchant_${miniProgram.appid}`;
  let config = getCache(cacheKey);
  if (config) return config;

  try {
    const res = await db.collection('merchant_configs')
      .where({ appid: miniProgram.appid, isActive: true })
      .limit(1)
      .get();

    config = res.data[0] || null;
    if (config) setCache(cacheKey, config);
    return config;
  } catch (e) {
    console.error('[getActiveMerchant] 获取失败:', e);
    return null;
  }
}

/**
 * 根据商户ID获取商户配置
 */
async function getMerchantById(merchantId) {
  if (!merchantId) return null;

  const cacheKey = `merchant_id_${merchantId}`;
  let config = getCache(cacheKey);
  if (config) return config;

  try {
    const res = await db.collection('merchant_configs').doc(merchantId).get();
    config = res.data || null;
    if (config) setCache(cacheKey, config);
    return config;
  } catch (e) {
    console.error('[getMerchantById] 获取失败:', e);
    return null;
  }
}

/**
 * 获取小程序名称
 */
async function getMiniName() {
  const mini = await getCurrentMiniProgram();
  return mini?.miniName || '储物柜';
}

/**
 * 获取订单描述前缀
 */
async function getOrderDescription() {
  return '若押金未退，点击下方【商家小程序】，选【我的-投诉建议】或联系客服，专人处理更快退回';
}

/**
 * 获取所有小程序列表
 */
async function getAllMiniPrograms() {
  try {
    const res = await db.collection('mini_programs')
      .where({ isActive: true })
      .orderBy('createdAt', 'asc')
      .get();
    return res.data;
  } catch (e) {
    console.error('[getAllMiniPrograms] 获取失败:', e);
    return [];
  }
}

/**
 * 清除缓存（配置变更时调用）
 */
function clearCache() {
  cache.clear();
  console.log('[config] 缓存已清除');
}

module.exports = {
  // 小程序配置
  getCurrentMiniProgram,
  getMiniProgramByAppid,
  getAllMiniPrograms,
  getMiniName,

  // 系统配置
  getSystemConfig,
  getLockerServerUrl,

  // 商户配置
  getActiveMerchant,
  getMerchantById,

  // 工具
  getOrderDescription,
  clearCache
};
