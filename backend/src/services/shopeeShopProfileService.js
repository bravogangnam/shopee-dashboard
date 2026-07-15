const db = require('../config/database');
const { CURRENT_TENANT_ID } = require('../config/tenant');
const { buildUrl } = require('../utils/shopeeSignature');
const { callWithRetry, shopeeAxios } = require('../utils/apiWrapper');
const { getOrRefreshShopToken } = require('./shopeeAuth');

const PROFILE_PATH = '/api/v2/shop/get_profile';
const SHOP_INFO_PATH = '/api/v2/shop/get_shop_info';

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeRegion(value) {
  const text = cleanText(value);
  return text ? text.toUpperCase() : null;
}

function safeErrorMessage(err) {
  const responseMessage = err?.responseData?.message || err?.response?.data?.message;
  const shopeeError = err?.shopeeError || err?.responseData?.error || err?.response?.data?.error;
  return [shopeeError, responseMessage || err?.message]
    .filter(Boolean)
    .join(': ')
    .replace(/access_token=[^&\s]+/gi, 'access_token=***')
    .replace(/refresh_token=[^&\s]+/gi, 'refresh_token=***');
}

function normalizeShopProfile({ shopId, profileData = {}, shopInfoData = {} }) {
  const profile = profileData.response || profileData || {};
  const info = shopInfoData.response || shopInfoData || {};
  return {
    shop_id: String(shopId),
    shop_name: cleanText(profile.shop_name || info.shop_name),
    region: normalizeRegion(info.region || info.country || profile.region || profile.country),
    shop_logo_url: cleanText(profile.shop_logo || profile.shop_logo_url || info.shop_logo || info.shop_logo_url),
  };
}

async function callShopApi(path, { accessToken, shopId, context }) {
  const url = buildUrl(path, {}, 'shop', accessToken, shopId);
  return callWithRetry(
    () => shopeeAxios.get(url),
    { context }
  );
}

async function syncShopProfile({ tenantId = CURRENT_TENANT_ID, shopId, accessToken = null } = {}) {
  const shopIdText = String(shopId ?? '').trim();
  if (!tenantId) throw new Error('tenantId is required');
  if (!/^\d+$/.test(shopIdText)) throw new Error('valid shopId is required');

  try {
    const [rows] = await db.query(
      'SELECT shop_id, access_token FROM shops WHERE tenant_id = ? AND shop_id = ? LIMIT 1',
      [tenantId, shopIdText]
    );
    if (!rows[0]) {
      return { shop_id: shopIdText, success: false, error: 'Shop not found for tenant' };
    }

    const token = accessToken || await getOrRefreshShopToken(shopIdText, { tenantId });
    if (!token) {
      return { shop_id: shopIdText, success: false, error: 'No active shop access token' };
    }

    const [profileData, shopInfoData] = await Promise.all([
      callShopApi(PROFILE_PATH, { accessToken: token, shopId: shopIdText, context: `syncShopProfile.get_profile(shop_id=${shopIdText})` }),
      callShopApi(SHOP_INFO_PATH, { accessToken: token, shopId: shopIdText, context: `syncShopProfile.get_shop_info(shop_id=${shopIdText})` }),
    ]);

    const normalized = normalizeShopProfile({ shopId: shopIdText, profileData, shopInfoData });

    await db.query(
      `UPDATE shops
       SET shop_name = COALESCE(?, shop_name),
           region = COALESCE(?, region),
           shop_logo_url = COALESCE(?, shop_logo_url),
           shop_info_synced_at = NOW(),
           updated_at = NOW()
       WHERE tenant_id = ? AND shop_id = ?`,
      [normalized.shop_name, normalized.region, normalized.shop_logo_url, tenantId, shopIdText]
    );

    return { ...normalized, success: true };
  } catch (err) {
    return { shop_id: shopIdText, success: false, error: safeErrorMessage(err) || 'Shop profile sync failed' };
  }
}

async function syncAllShopProfiles({ tenantId = CURRENT_TENANT_ID, shopIds = null } = {}) {
  if (!tenantId) throw new Error('tenantId is required');
  let ids = shopIds;
  if (!Array.isArray(ids)) {
    const [rows] = await db.query(
      'SELECT shop_id FROM shops WHERE tenant_id = ? AND is_active = 1 ORDER BY id ASC',
      [tenantId]
    );
    ids = rows.map(row => row.shop_id);
  }

  const results = [];
  for (const id of ids) {
    results.push(await syncShopProfile({ tenantId, shopId: id }));
  }

  const updated = results.filter(row => row.success).length;
  const failed = results.length - updated;
  return { total: results.length, updated, failed, results };
}

module.exports = {
  PROFILE_PATH,
  SHOP_INFO_PATH,
  normalizeShopProfile,
  syncShopProfile,
  syncAllShopProfiles,
};
