// 根据 pem 内容识别证书类型
function detectCertType(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.includes('-----BEGIN PRIVATE KEY-----')) return { ok: true, label: '私钥' };
  if (t.includes('-----BEGIN CERTIFICATE-----')) return { ok: true, label: '证书' };
  if (t.includes('-----BEGIN PUBLIC KEY-----')) return { ok: true, label: '公钥' };
  return { ok: false, label: '格式错误' };
}

// 由退款回调地址派生投诉回调地址（同一云环境域名）
function deriveComplaintUrl(notifyUrl) {
  const url = String(notifyUrl || '').trim();
  if (!url) return '';
  return url.replace(/\/paynotify\/?$/, '/wxpay-complaint');
}

function getCurrentAppid() {
  try {
    return wx.getAccountInfoSync().miniProgram.appId || '';
  } catch (e) {
    return '';
  }
}

Page({
  data: {
    loading: true,
    merchantList: [],
    // 可用商户数（非限制状态）
    availableCount: 0,
    // 全局限额（达到后自动切换，0 表示不限）
    limits: { dailyOrderLimit: 0, complaintRateLimit: 0 },
    orderLimitInput: '0',
    rateLimitInput: '0',
    // 添加商户表单
    showAddModal: false,
    addSubmitting: false,
    defaultNotifyUrl: '',
    showJsonPaste: false,
    jsonInput: '',
    pasteMode: { privateKey: false, publicCert: false },
    certInfo: { privateKey: null, publicCert: null },
    addForm: {
      name: '',
      mchid: '',
      merchantSerialNo: '',
      apiv3Key: '',
      appid: '',
      miniName: '',
      notifyUrl: '',
      complaintNotifyUrl: '',
      privateKey: '',
      publicCert: ''
    },
    // 最近一次添加成功的参数（投诉回调配置失败时用于重试）
    lastAdd: null
  },

  onLoad() {
    this.checkPermission();
  },

  async checkPermission() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'amIAdmin' }
      });
      if (!res.result.isAdmin || res.result.role !== 'super') {
        wx.showToast({ title: '无权限访问', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }
      this.fetchMerchants();
    } catch (err) {
      console.error('权限检查失败：', err);
      wx.navigateBack();
    }
  },

  async fetchMerchants() {
    try {
      this.setData({ loading: true });
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'getMerchantConfigs' }
      });
      if (res.result && res.result.success && res.result.data) {
        const limits = res.result.limits || { dailyOrderLimit: 0, complaintRateLimit: 0 };
        const list = res.result.data.map(m => {
          const todayOrders = m.todayOrders || 0;
          const todayComplaints = m.todayComplaints || 0;
          const totalOrders = m.totalOrders || 0;
          const totalComplaints = m.totalComplaints || 0;
          const todayRate = todayOrders > 0
            ? (100 * todayComplaints / todayOrders).toFixed(2)
            : (todayComplaints > 0 ? '100.00' : '0.00');
          return {
            ...m,
            status: m.status || 'normal',
            isRestricted: (m.status || 'normal') === 'restricted',
            todayOrders,
            todayComplaints,
            totalOrders,
            totalComplaints,
            consecutivePayFails: m.consecutivePayFails || 0,
            // 默认参与自动轮换（字段缺失视为 true）
            autoRotate: m.autoRotate !== false,
            todayRate,
            totalRate: totalOrders > 0
              ? (100 * totalComplaints / totalOrders).toFixed(2)
              : '0.00',
            // 今日投诉率是否已达阈值（用于红色高亮，阈值为全局限额）
            todayRateDanger: (limits.complaintRateLimit > 0) && Number(todayRate) >= limits.complaintRateLimit
          };
        });
        // 排序：使用中 > 正常 > 限制，同组内按 order 权重升序
        list.sort((a, b) => {
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          if (a.isRestricted !== b.isRestricted) return a.isRestricted ? 1 : -1;
          return (a.order || 99) - (b.order || 99);
        });
        this.setData({
          merchantList: list,
          availableCount: list.filter(m => !m.isRestricted).length,
          limits,
          orderLimitInput: String(limits.dailyOrderLimit || 0),
          rateLimitInput: String(limits.complaintRateLimit || 0),
          defaultNotifyUrl: res.result.defaultNotifyUrl || '',
          loading: false
        });
      } else {
        this.setData({ loading: false });
        wx.showToast({ title: (res.result && res.result.errMsg) || '加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('获取商户列表失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 切换使用（restricted 商户在 wxml 中已禁用按钮）
  async switchMerchant(e) {
    const { id, name } = e.currentTarget.dataset;
    const confirm = await wx.showModal({
      title: '切换商户',
      content: `确定切换到「${name}」吗？切换后新订单将使用该商户收款。`,
      confirmText: '确定切换'
    });
    if (!confirm.confirm) return;

    wx.showLoading({ title: '切换中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'switchMerchant', merchantId: id }
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        wx.showToast({ title: '已切换', icon: 'success' });
        this.fetchMerchants();
      } else {
        wx.showToast({ title: (res.result && res.result.errMsg) || '切换失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('切换商户失败:', err);
      wx.showToast({ title: '切换失败', icon: 'none' });
    }
  },

  // 标记限制 / 恢复正常
  async toggleStatus(e) {
    const { id, name, status } = e.currentTarget.dataset;
    const toRestricted = status !== 'restricted';
    const confirm = await wx.showModal({
      title: toRestricted ? '标记限制' : '恢复正常',
      content: toRestricted
        ? `确定将「${name}」标记为限制状态吗？若该商户正在使用中，将自动切换到下一个可用商户。`
        : `确定将「${name}」恢复为正常状态吗？恢复后可以被切换使用。`,
      confirmText: '确定'
    });
    if (!confirm.confirm) return;

    wx.showLoading({ title: '处理中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'updateMerchantStatus',
          merchantId: id,
          status: toRestricted ? 'restricted' : 'normal'
        }
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        const autoSwitch = res.result.autoSwitch;
        if (toRestricted && autoSwitch && autoSwitch.switched) {
          wx.showToast({ title: `已限制并切换到${autoSwitch.name}`, icon: 'none' });
        } else if (toRestricted && autoSwitch && !autoSwitch.switched) {
          wx.showModal({ title: '已标记限制', content: '但没有其他可用商户可切换，请尽快处理！', showCancel: false });
        } else {
          wx.showToast({ title: res.result.message || '已完成', icon: 'success' });
        }
        this.fetchMerchants();
      } else {
        wx.showToast({ title: (res.result && res.result.errMsg) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('修改商户状态失败:', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // 删除商户（仅未使用中商户显示入口；后端校验使用状态与未完成订单）
  async deleteMerchant(e) {
    const { id, name, mchid } = e.currentTarget.dataset;
    const confirm = await wx.showModal({
      title: '删除商户',
      content: `确定删除「${name}」（${mchid}）吗？\n删除后不可恢复；如需重新绑定，删除后可在页面重新添加（会重新验证凭证）。`,
      confirmText: '删除',
      confirmColor: '#dc2626'
    });
    if (!confirm.confirm) return;

    wx.showLoading({ title: '删除中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'deleteMerchant', merchantId: id }
      });
      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        if (result.historicalCount > 0) {
          wx.showModal({
            title: '已删除',
            content: `注意：该商户名下有 ${result.historicalCount} 笔历史订单，今后如需为这些订单退款将无法通过原商户执行。`,
            showCancel: false
          });
        } else {
          wx.showToast({ title: '已删除', icon: 'success' });
        }
        this.fetchMerchants();
      } else {
        wx.showModal({ title: '无法删除', content: result.errMsg || '删除失败', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('删除商户失败:', err);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  onOrderLimitInput(e) {
    this.setData({ orderLimitInput: e.detail.value });
  },

  // 设置是否参与自动轮换
  async onAutoRotateChange(e) {
    const { id } = e.currentTarget.dataset;
    const autoRotate = e.detail.value;
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: { action: 'updateMerchantAutoRotate', merchantId: id, autoRotate }
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: res.result.message || '已设置', icon: 'none' });
      } else {
        wx.showToast({ title: (res.result && res.result.errMsg) || '设置失败', icon: 'none' });
      }
    } catch (err) {
      console.error('设置自动轮换失败:', err);
      wx.showToast({ title: '设置失败', icon: 'none' });
    }
    this.fetchMerchants();
  },

  onRateLimitInput(e) {
    this.setData({ rateLimitInput: e.detail.value });
  },

  async saveLimits() {
    const orderLimit = Number(this.data.orderLimitInput);
    const rateLimit = Number(this.data.rateLimitInput);
    if (isNaN(orderLimit) || orderLimit < 0 || !Number.isInteger(orderLimit)) {
      wx.showToast({ title: '订单限额须为不小于0的整数', icon: 'none' });
      return;
    }
    if (isNaN(rateLimit) || rateLimit < 0 || rateLimit > 100) {
      wx.showToast({ title: '投诉率阈值须在0~100之间', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'updateMerchantLimits',
          dailyOrderLimit: orderLimit,
          complaintRateLimit: rateLimit
        }
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        wx.showToast({ title: '已保存', icon: 'success' });
        this.fetchMerchants();
      } else {
        wx.showToast({ title: (res.result && res.result.errMsg) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('保存限额失败:', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  // ================= 添加商户 =================

  openAddModal() {
    const form = this.data.addForm;
    const notifyUrl = form.notifyUrl || this.data.defaultNotifyUrl || '';
    this.setData({
      showAddModal: true,
      'addForm.appid': form.appid || getCurrentAppid(),
      'addForm.notifyUrl': notifyUrl,
      'addForm.complaintNotifyUrl': form.complaintNotifyUrl || deriveComplaintUrl(notifyUrl)
    });
  },

  async closeAddModal() {
    const f = this.data.addForm;
    const hasInput = f.name || f.mchid || f.privateKey || f.publicCert;
    if (hasInput) {
      const confirm = await wx.showModal({
        title: '放弃填写',
        content: '已填写的内容将保留在表单中，确定关闭吗？',
        confirmText: '关闭'
      });
      if (!confirm.confirm) return;
    }
    this.setData({ showAddModal: false });
  },

  onAddFormInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    const patch = { [`addForm.${field}`]: value };
    // 退款回调变化时自动派生投诉回调
    if (field === 'notifyUrl') {
      patch['addForm.complaintNotifyUrl'] = deriveComplaintUrl(value);
    }
    // 证书内容变化时更新类型徽标
    if (field === 'privateKey' || field === 'publicCert') {
      patch[`certInfo.${field}`] = detectCertType(value);
    }
    this.setData(patch);
  },

  togglePaste(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`pasteMode.${field}`]: !this.data.pasteMode[field] });
  },

  // ================= JSON 快速填入 =================

  toggleJsonPaste() {
    this.setData({ showJsonPaste: !this.data.showJsonPaste });
  },

  onJsonInput(e) {
    this.setData({ jsonInput: e.detail.value });
  },

  // 解析粘贴的配置 JSON（兼容尾逗号、宽松 key:value），填入表单对应字段
  parseJsonInput() {
    const text = String(this.data.jsonInput || '').trim();
    if (!text) {
      wx.showToast({ title: '请先粘贴JSON内容', icon: 'none' });
      return;
    }

    let obj = null;
    try {
      // 容错：去掉末尾多余逗号后再按标准 JSON 解析
      obj = JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch (e) {
      // 宽松提取："key":"value" 形式
      obj = {};
      ['name', 'mchid', 'merchantSerialNo', 'apiv3Key', 'appid', 'miniName',
        'notify_url', 'notifyUrl', 'complaintNotifyUrl', 'privateKey', 'publicCert'].forEach(k => {
        const m = text.match(new RegExp('["\']?' + k + '["\']?\\s*[:：]\\s*["\']([^"\']+)["\']'));
        if (m) obj[k] = m[1];
      });
    }

    const fieldMap = {
      name: 'name',
      mchid: 'mchid',
      merchantSerialNo: 'merchantSerialNo',
      apiv3Key: 'apiv3Key',
      appid: 'appid',
      miniName: 'miniName',
      notify_url: 'notifyUrl',
      notifyUrl: 'notifyUrl',
      complaintNotifyUrl: 'complaintNotifyUrl',
      privateKey: 'privateKey',
      publicCert: 'publicCert'
    };

    const patch = {};
    let filled = 0;
    Object.keys(fieldMap).forEach(key => {
      const v = obj ? obj[key] : undefined;
      if (v === undefined || v === null || String(v).trim() === '') return;
      const target = fieldMap[key];
      patch[`addForm.${target}`] = String(v).trim();
      if (target === 'privateKey' || target === 'publicCert') {
        patch[`certInfo.${target}`] = detectCertType(String(v));
      }
      filled++;
    });

    if (!filled) {
      wx.showToast({ title: '未解析到可填入的字段', icon: 'none' });
      return;
    }

    // 填了退款回调但没填投诉回调时自动派生
    if (patch['addForm.notifyUrl'] && !patch['addForm.complaintNotifyUrl']) {
      patch['addForm.complaintNotifyUrl'] = deriveComplaintUrl(patch['addForm.notifyUrl']);
    }

    this.setData({ ...patch, showJsonPaste: false, jsonInput: '' });
    wx.showToast({ title: `已填入 ${filled} 项`, icon: 'none' });
  },

  // 从微信聊天记录中选择 pem 文件并读取内容
  chooseCertFile(e) {
    const field = e.currentTarget.dataset.field;
    if (!wx.chooseMessageFile) {
      wx.showToast({ title: '当前环境不支持选文件，请使用粘贴', icon: 'none' });
      this.setData({ [`pasteMode.${field}`]: true });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => {
        const f = res.tempFiles[0];
        if (f.size > 20 * 1024) {
          wx.showToast({ title: '文件过大，请确认选择的是 pem 证书文件', icon: 'none' });
          return;
        }
        wx.getFileSystemManager().readFile({
          filePath: f.path,
          encoding: 'utf8',
          success: (r) => {
            const content = String(r.data || '').trim();
            const info = detectCertType(content);
            if (field === 'privateKey' && (!info || info.label !== '私钥')) {
              wx.showToast({ title: '选择的不是商户私钥（apiclient_key.pem）', icon: 'none' });
              return;
            }
            if (field === 'publicCert' && (!info || !info.ok || info.label === '私钥')) {
              wx.showToast({ title: '请选择商户证书或微信支付公钥文件', icon: 'none' });
              return;
            }
            this.setData({
              [`addForm.${field}`]: content,
              [`certInfo.${field}`]: { ...info, fileName: f.name },
              [`pasteMode.${field}`]: false
            });
          },
          fail: () => {
            wx.showToast({ title: '文件读取失败', icon: 'none' });
          }
        });
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || '';
        console.error('chooseMessageFile 失败:', errMsg);
        // 用户主动取消，静默返回
        if (errMsg.includes('cancel')) return;
        // 失败时自动降级为粘贴，保证流程不中断
        this.setData({ [`pasteMode.${field}`]: true });
        if (/privacy|隐私/i.test(errMsg)) {
          // 后台《用户隐私保护指引》未声明"选择文件"权限时真机会走到这里
          wx.showToast({ title: '小程序未声明"选择文件"隐私权限，请改用下方粘贴', icon: 'none', duration: 3000 });
        } else {
          wx.showToast({ title: '选择文件失败，请改用粘贴：' + errMsg, icon: 'none', duration: 3000 });
        }
      }
    });
  },

  // 提交添加商户（后端会先向微信侧实测凭证，通过才入库）
  async submitAddMerchant() {
    if (this.data.addSubmitting) return;
    const f = this.data.addForm;
    const name = f.name.trim();
    const mchid = f.mchid.trim();
    const apiv3Key = f.apiv3Key.trim();
    const serialNo = f.merchantSerialNo.trim();
    const appid = f.appid.trim();

    if (!name) { wx.showToast({ title: '请填写商户名称', icon: 'none' }); return; }
    if (!/^\d{6,32}$/.test(mchid)) { wx.showToast({ title: '商户号应为6~32位数字', icon: 'none' }); return; }
    if (!serialNo) {
      const pubInfo = detectCertType(f.publicCert);
      if (!pubInfo || pubInfo.label !== '证书') {
        wx.showToast({ title: '公钥模式无法自动解析序列号，请手填', icon: 'none' });
        return;
      }
    } else if (!/^[0-9A-Fa-f]{10,40}$/.test(serialNo)) {
      wx.showToast({ title: '证书序列号应为10~40位十六进制', icon: 'none' });
      return;
    }
    if (apiv3Key.length !== 32) { wx.showToast({ title: 'APIv3密钥应为32位', icon: 'none' }); return; }
    if (!appid) { wx.showToast({ title: '请填写关联小程序appid', icon: 'none' }); return; }

    const keyInfo = detectCertType(f.privateKey);
    if (!keyInfo || keyInfo.label !== '私钥') {
      wx.showToast({ title: '请提供商户私钥（apiclient_key.pem）', icon: 'none' });
      return;
    }
    const certInfo = detectCertType(f.publicCert);
    if (!certInfo || !certInfo.ok || certInfo.label === '私钥') {
      wx.showToast({ title: '请提供商户证书或微信支付公钥（二选一）', icon: 'none' });
      return;
    }

    if (!/^https:\/\//.test(f.notifyUrl.trim())) { wx.showToast({ title: '退款回调地址须以https://开头', icon: 'none' }); return; }
    if (!/^https:\/\//.test(f.complaintNotifyUrl.trim())) { wx.showToast({ title: '投诉回调地址须以https://开头', icon: 'none' }); return; }

    this.setData({ addSubmitting: true });
    wx.showLoading({ title: '提交并验证凭证...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'addMerchant',
          name,
          mchid,
          merchantSerialNo: serialNo,
          apiv3Key,
          appid,
          miniName: f.miniName.trim(),
          notify_url: f.notifyUrl.trim(),
          complaintNotifyUrl: f.complaintNotifyUrl.trim(),
          privateKey: f.privateKey.trim(),
          publicCert: f.publicCert.trim()
        }
      });
      wx.hideLoading();
      this.setData({ addSubmitting: false });
      const result = res.result || {};
      if (!result.success) {
        wx.showModal({ title: '添加失败', content: result.errMsg || '未知错误', showCancel: false });
        return;
      }

      // 成功：重置表单并关闭弹窗
      this.setData({
        showAddModal: false,
        pasteMode: { privateKey: false, publicCert: false },
        certInfo: { privateKey: null, publicCert: null },
        addForm: {
          name: '', mchid: '', merchantSerialNo: '', apiv3Key: '',
          appid: getCurrentAppid(), miniName: '',
          notifyUrl: this.data.defaultNotifyUrl || '',
          complaintNotifyUrl: deriveComplaintUrl(this.data.defaultNotifyUrl),
          privateKey: '', publicCert: ''
        },
        lastAdd: { appid, mchid, complaintNotifyUrl: f.complaintNotifyUrl.trim() }
      });

      const notifyInit = result.notifyInit;
      if (notifyInit && notifyInit.success === false) {
        const confirm = await wx.showModal({
          title: '商户已添加，但投诉回调配置失败',
          content: (notifyInit.errMsg || notifyInit.message || '') + '\n可立即重试配置。',
          confirmText: '重试配置'
        });
        if (confirm.confirm) this.retryNotifyInit();
      } else {
        const warn = result.verifyWarning ? '\n注意：' + result.verifyWarning : '';
        wx.showModal({
          title: '添加成功',
          content: '新商户默认未启用，请在列表中点击"切换使用"后开始收款。' + warn,
          showCancel: false
        });
      }
      this.fetchMerchants();
    } catch (err) {
      wx.hideLoading();
      this.setData({ addSubmitting: false });
      console.error('添加商户失败:', err);
      wx.showModal({ title: '添加失败', content: err.errMsg || err.message || '网络异常', showCancel: false });
    }
  },

  // 重试配置投诉回调（addMerchant 成功但 notifyInit 失败时）
  async retryNotifyInit() {
    const last = this.data.lastAdd;
    if (!last) return;
    wx.showLoading({ title: '配置中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'admin',
        data: {
          action: 'initComplaintNotify',
          appid: last.appid,
          mchid: last.mchid,
          notifyUrl: last.complaintNotifyUrl
        }
      });
      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        wx.showToast({ title: '投诉回调已配置', icon: 'success' });
      } else {
        wx.showModal({ title: '配置失败', content: result.errMsg || '请稍后重试', showCancel: false });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('重试配置投诉回调失败:', err);
      wx.showToast({ title: '配置失败', icon: 'none' });
    }
  }
});
