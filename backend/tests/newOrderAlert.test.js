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
assert.match(alertService, /p\.product_name_kr/);
assert.match(alertService, /p\.sku COLLATE utf8mb4_general_ci/);
assert.match(alertService, /productName: row\.product_name_kr \|\| row\.item_name/);
assert.match(alertService, /optionName: row\.product_name_kr \? ''/);
assert.match(alertService, /alert\.displayStatus !== 'READY_TO_SHIP'/);

const pushService = fs.readFileSync(path.join(__dirname, '../src/services/shopeePushService.js'), 'utf8');
const syncWorker = fs.readFileSync(path.join(__dirname, '../src/jobs/syncWorker.js'), 'utf8');
assert.match(pushService, /notifyNewOrderOnce/);
assert.match(pushService, /applied\.displayStatus === 'READY_TO_SHIP'/);
assert.match(syncWorker, /notifyNewOrderOnce/);
assert.match(syncWorker, /applied\.displayStatus === 'READY_TO_SHIP'/);
assert.match(syncWorker, /applied\.previousDisplayStatus !== 'READY_TO_SHIP'/);

console.log('new order Telegram alert tests passed');
