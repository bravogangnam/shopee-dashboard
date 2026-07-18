const assert = require('assert');
const { addClient, publishOrderChange } = require('../src/services/orderEventHub');

const messages = [];
const response = {
  destroyed: false,
  writableEnded: false,
  write(message) { messages.push(message); },
};

const remove = addClient(7, response);
assert.strictEqual(publishOrderChange(8, { order_sn: 'OTHER' }), 0);
assert.strictEqual(publishOrderChange(7, { order_sn: 'TEST123', code: 3 }), 1);
assert.match(messages[0], /^event: order-change\ndata: /);
assert.match(messages[0], /"order_sn":"TEST123"/);
remove();
assert.strictEqual(publishOrderChange(7, { order_sn: 'TEST123' }), 0);

console.log('orderEventHub tests passed');
