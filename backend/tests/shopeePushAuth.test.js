const assert = require('assert');
const {
  calculatePushAuthorization,
  verifyPushAuthorization,
} = require('../src/services/shopeePushAuth');

const callbackUrl = 'https://example.com/api/shopee/push';
const rawBody = '{"code":3,"shop_id":123,"data":{"ordersn":"ABC"}}';
const partnerKey = 'test-partner-key';
const authorization = calculatePushAuthorization(callbackUrl, rawBody, partnerKey);

assert.strictEqual(authorization.length, 64);
assert.strictEqual(verifyPushAuthorization({ callbackUrl, rawBody, partnerKey, authorization }), true);
assert.strictEqual(verifyPushAuthorization({ callbackUrl, rawBody: `${rawBody} `, partnerKey, authorization }), false);
assert.strictEqual(verifyPushAuthorization({ callbackUrl: `${callbackUrl}/`, rawBody, partnerKey, authorization }), false);
assert.strictEqual(verifyPushAuthorization({ callbackUrl, rawBody, partnerKey, authorization: 'invalid' }), false);

console.log('shopeePushAuth tests passed');
