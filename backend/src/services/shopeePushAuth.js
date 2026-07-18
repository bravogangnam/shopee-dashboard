const crypto = require('crypto');

function calculatePushAuthorization(callbackUrl, rawBody, partnerKey) {
  return crypto
    .createHmac('sha256', String(partnerKey))
    .update(`${callbackUrl}|${rawBody}`)
    .digest('hex');
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left)) || !/^[a-f0-9]{64}$/i.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function verifyPushAuthorization({ callbackUrl, rawBody, partnerKey, authorization }) {
  return safeEqualHex(
    calculatePushAuthorization(callbackUrl, rawBody, partnerKey),
    authorization
  );
}

module.exports = { calculatePushAuthorization, verifyPushAuthorization };
