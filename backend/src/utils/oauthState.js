const crypto = require('crypto');
const { CURRENT_TENANT_ID, normalizeTenantId } = require('../config/tenant');

const STATE_TTL_SECONDS = 10 * 60;
const STATE_SECRET =
  process.env.SHOPEE_OAUTH_STATE_SECRET ||
  process.env.JWT_SECRET ||
  'shopee_oauth_state_secret';

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLength), 'base64').toString('utf8');
}

function sign(payload) {
  return crypto
    .createHmac('sha256', STATE_SECRET)
    .update(payload)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createOAuthState({ tenantId = CURRENT_TENANT_ID } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    tenant_id: normalizeTenantId(tenantId),
    iat: now,
    exp: now + STATE_TTL_SECONDS,
    nonce: crypto.randomBytes(12).toString('hex'),
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function verifyOAuthState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) {
    return { valid: false, tenantId: CURRENT_TENANT_ID, reason: 'missing_state' };
  }

  const [encodedPayload, signature] = state.split('.');
  const expectedSignature = sign(encodedPayload);

  if (!safeEqual(signature, expectedSignature)) {
    return { valid: false, tenantId: CURRENT_TENANT_ID, reason: 'invalid_signature' };
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (!payload.exp || payload.exp < now) {
      return { valid: false, tenantId: CURRENT_TENANT_ID, reason: 'expired_state' };
    }

    return {
      valid: true,
      tenantId: normalizeTenantId(payload.tenant_id),
      payload,
    };
  } catch (err) {
    return { valid: false, tenantId: CURRENT_TENANT_ID, reason: 'invalid_payload' };
  }
}

module.exports = {
  createOAuthState,
  verifyOAuthState,
};
