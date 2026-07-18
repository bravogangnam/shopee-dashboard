const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildGuardedSnapshotDiff,
  findMissingOrderItems,
  lockName,
} = require('../src/services/orderSnapshotPolicy');

function snapshot(updateTime, status, extra = {}) {
  return { update_time: updateTime, order_status: status, display_status: status, ...extra };
}

{
  const existing = snapshot(200, 'SHIPPED');
  const incoming = snapshot(100, 'READY_TO_SHIP');
  const guarded = buildGuardedSnapshotDiff(existing, incoming, {
    order_status: incoming.order_status,
    display_status: incoming.display_status,
    update_time: incoming.update_time,
  });
  assert.strictEqual(guarded.relation, 'stale');
  assert.deepStrictEqual(guarded.diff, {}, 'older polling must not overwrite a newer push');
}

{
  const existing = snapshot(100, 'READY_TO_SHIP');
  const incoming = snapshot(200, 'SHIPPED');
  const guarded = buildGuardedSnapshotDiff(existing, incoming, {
    order_status: incoming.order_status,
    display_status: incoming.display_status,
    update_time: incoming.update_time,
  });
  assert.strictEqual(guarded.relation, 'newer');
  assert.strictEqual(guarded.diff.order_status, 'SHIPPED');
  assert.strictEqual(guarded.diff.update_time, 200);
}

{
  const existing = snapshot(200, 'SHIPPED', { tracking_number: null });
  const incoming = snapshot(200, 'SHIPPED', { tracking_number: 'TRACK-1' });
  const guarded = buildGuardedSnapshotDiff(existing, incoming, { tracking_number: 'TRACK-1' });
  assert.strictEqual(guarded.relation, 'equal');
  assert.deepStrictEqual(guarded.diff, {}, 'equal-time tracking is handled by the supplement path');
}

{
  const existing = [{ item_id: 1, model_id: 10, model_sku: 'SKU-A' }];
  const incoming = [
    { item_id: 1, model_id: 10, model_sku: 'SKU-A' },
    { item_id: 2, model_id: 20, model_sku: 'SKU-B' },
    { item_id: 2, model_id: 20, model_sku: 'SKU-B' },
  ];
  const missing = findMissingOrderItems(existing, incoming);
  assert.strictEqual(missing.length, 1, 'only the missing option item must be repaired');
  assert.strictEqual(missing[0].model_sku, 'SKU-B');
  assert.strictEqual(findMissingOrderItems([], incoming).length, 2, 'zero-item failure state must recover all unique items');
}

assert.strictEqual(
  lockName(1, 123, 'ORDER-1'),
  lockName(1, 123, 'ORDER-1'),
  'push and polling must contend on the same order lock'
);

const schema = fs.readFileSync(path.join(__dirname, '../src/config/schema.sql'), 'utf8');
assert.match(schema, /UNIQUE KEY uq_order_shop \(order_sn, shop_id\)/);
assert.match(schema, /UNIQUE KEY uniq_inventory_sale \(movement_type, order_sn, shop_id, sku, item_id, model_id\)/);
assert.match(schema, /UNIQUE KEY uniq_inventory_allocation \(movement_id, batch_id\)/);

const snapshotService = fs.readFileSync(path.join(__dirname, '../src/services/orderSnapshotService.js'), 'utf8');
assert.match(snapshotService, /GET_LOCK\(\?, 10\)/);
assert.match(snapshotService, /repairMissingOrderItems/);
assert.match(snapshotService, /if \(created \|\| inventoryRelevantUpdate\)/);

const orderDb = fs.readFileSync(path.join(__dirname, '../src/services/orderDb.js'), 'utf8');
assert.match(orderDb, /update_time IS NULL OR update_time <= \?/);
assert.match(orderDb, /processInventory: false/);
assert.match(orderDb, /COALESCE\(NULLIF\(\$\{field\}, ''\), \?\)/);

console.log('order snapshot concurrency and recovery tests passed');
