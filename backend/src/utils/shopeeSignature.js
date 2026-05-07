/**
 * Shopee API v2 Signature Utility
 * 
 * Signature Base String format:
 * - Public API (no access_token/shop_id): partner_id + path + timestamp
 * - Shop-level API: partner_id + path + timestamp + access_token + shop_id
 * - Merchant-level API: partner_id + path + timestamp + access_token + merchant_id
 * 
 * Ref: https://open.shopee.com/documents/v2/v2.request.v2Signature
 */

const crypto = require('crypto');
require('dotenv').config();

const PARTNER_ID = parseInt(process.env.SHOPEE_PARTNER_ID);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;
const BASE_URL = 'https://partner.shopeemobile.com';

/**
 * Generate HMAC-SHA256 signature
 * @param {string} baseString
 * @returns {string} hex signature
 */
function hmacSHA256(baseString) {
  return crypto
    .createHmac('sha256', PARTNER_KEY)
    .update(baseString)
    .digest('hex');
}

/**
 * Get current Unix timestamp (seconds)
 */
function getTimestamp() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Generate signature for PUBLIC APIs (no auth required)
 * base_string = partner_id + path + timestamp
 */
function signPublic(path) {
  const ts = getTimestamp();
  const baseString = `${PARTNER_ID}${path}${ts}`;
  const sign = hmacSHA256(baseString);
  return { timestamp: ts, sign, partner_id: PARTNER_ID };
}

/**
 * Generate signature for SHOP-LEVEL APIs
 * base_string = partner_id + path + timestamp + access_token + shop_id
 */
function signShop(path, accessToken, shopId) {
  const ts = getTimestamp();
  const baseString = `${PARTNER_ID}${path}${ts}${accessToken}${shopId}`;
  const sign = hmacSHA256(baseString);
  return { timestamp: ts, sign, partner_id: PARTNER_ID };
}

/**
 * Generate signature for MERCHANT-LEVEL APIs
 * base_string = partner_id + path + timestamp + access_token + merchant_id
 */
function signMerchant(path, accessToken, merchantId) {
  const ts = getTimestamp();
  const baseString = `${PARTNER_ID}${path}${ts}${accessToken}${merchantId}`;
  const sign = hmacSHA256(baseString);
  return { timestamp: ts, sign, partner_id: PARTNER_ID };
}

/**
 * Build full Shopee API URL with query params + signature
 * @param {string} path - e.g. '/api/v2/auth/token/get'
 * @param {object} params - additional query params
 * @param {string} type - 'public' | 'shop' | 'merchant'
 * @param {string} accessToken
 * @param {string|number} id - shop_id or merchant_id
 */
function buildUrl(path, params = {}, type = 'public', accessToken = '', id = '') {
  let signData;
  
  switch (type) {
    case 'shop':
      signData = signShop(path, accessToken, id);
      break;
    case 'merchant':
      signData = signMerchant(path, accessToken, id);
      break;
    default:
      signData = signPublic(path);
  }

  const queryParams = new URLSearchParams({
    partner_id: String(PARTNER_ID),
    timestamp: String(signData.timestamp),
    sign: signData.sign,
    ...params,
  });

  if (type === 'shop' && id) {
    queryParams.set('shop_id', String(id));
  }
  if (type === 'merchant' && id) {
    queryParams.set('merchant_id', String(id));
  }
  if (accessToken) {
    queryParams.set('access_token', accessToken);
  }

  return `${BASE_URL}${path}?${queryParams.toString()}`;
}

/**
 * Generate Shopee OAuth authorization URL
 * For main account (merchant) authorization
 */
function getAuthUrl(redirectUrl, extraParams = {}) {
  const path = '/api/v2/shop/auth_partner';
  const { timestamp, sign } = signPublic(path);

  const params = new URLSearchParams({
    partner_id: String(PARTNER_ID),
    timestamp: String(timestamp),
    sign,
    redirect: redirectUrl,
    ...extraParams,
  });

  return `${BASE_URL}${path}?${params.toString()}`;
}

module.exports = {
  signPublic,
  signShop,
  signMerchant,
  buildUrl,
  getAuthUrl,
  getTimestamp,
  PARTNER_ID,
  BASE_URL,
};
