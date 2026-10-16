const cloud = require('wx-server-sdk');
const { adapter } = require('./database');
const { createService } = require('./service');
const cloudbase = require('@cloudbase/node-sdk');
const { storageAdapter } = require('./storage');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const storage = storageAdapter(cloud, cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV }));
const service = createService({ db: adapter(cloud.database({ throwOnNotFound: false })), storage });

exports.main = async (event) => {
  try {
    // Never accept OPENID/userId/role from event or an HTTP header.
    const context = cloud.getWXContext();
    const data = await service(event, context);
    return { ok: true, data };
  } catch (error) {
    if (error.code && error.public) return { ok: false, error: { code: error.code, message: error.message } };
    // Do not log input, OpenID, invite tokens, photos, or diary content.
    console.error('diaryApi failed', { code: error.errCode || 'INTERNAL' });
    return { ok: false, error: { code: 'INTERNAL', message: '云端操作失败，请稍后重试' } };
  }
};
