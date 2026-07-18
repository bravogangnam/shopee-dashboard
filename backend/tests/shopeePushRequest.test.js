const assert = require('assert');
const { classifyPushRequest } = require('../src/services/shopeePushRequest');

assert.strictEqual(classifyPushRequest({}).type, 'verification');
assert.strictEqual(classifyPushRequest({ code: 0, shop_id: 0 }).type, 'verification');
assert.strictEqual(classifyPushRequest({ code: 99, shop_id: 123 }).type, 'verification');
assert.deepStrictEqual(
  classifyPushRequest({ code: 3, shop_id: 123 }),
  { type: 'operational', shopId: 123, code: 3 }
);
assert.strictEqual(classifyPushRequest({ code: 4, shop_id: 123 }).type, 'operational');
assert.strictEqual(classifyPushRequest({ code: 15, shop_id: 123 }).type, 'operational');

console.log('shopee push request classification tests passed');
