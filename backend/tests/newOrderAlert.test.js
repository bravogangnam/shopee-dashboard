const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { formatNewOrderProductLine, resolveUnitPrice } = require('../src/utils/telegramNotifier');

assert.strictEqual(resolveUnitPrice('12.50', '15.00'), 12.5);
assert.strictEqual(resolveUnitPrice(null, '15.00'), 15);
assert.strictEqual(resolveUnitPrice('0', '15.00'), 15);
assert.strictEqual(resolveUnitPrice(null, null), null);

const detail = formatNewOrderProductLine({
  productName: '테스트 상품',
  optionName: 'Blue / Large',
  qty: 2,
  unitPrice: 12.5,
  currency: 'MYR',
});
assert.match(detail, /상품명: 테스트 상품/);
assert.match(detail, /옵션명: Blue \/ Large/);
assert.match(detail, /수량: 2개/);
assert.match(detail, /판매가: 12\.5 MYR/);

const alertService = fs.readFileSync(path.join(__dirname, '../src/services/newOrderAlertService.js'), 'utf8');
assert.match(alertService, /UNIQUE KEY uq_order_alert_delivery \(tenant_id, shop_id, order_sn, alert_type\)/);
assert.match(alertService, /INSERT IGNORE INTO order_alert_deliveries/);
assert.match(alertService, /status='sent'/);
assert.match(alertService, /JOIN order_items oi/);
assert.match(alertService, /model_discounted_price/);
assert.match(alertService, /model_original_price/);

const pushService = fs.readFileSync(path.join(__dirname, '../src/services/shopeePushService.js'), 'utf8');
const syncWorker = fs.readFileSync(path.join(__dirname, '../src/jobs/syncWorker.js'), 'utf8');
assert.match(pushService, /notifyNewOrderOnce/);
assert.match(syncWorker, /notifyNewOrderOnce/);

console.log('new order Telegram alert tests passed');
