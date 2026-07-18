const db = require('../config/database');
const { diffOrderRow } = require('./shopeeOrder');
const {
  batchInsertOrders,
  repairMissingOrderItems,
  supplementOrderFields,
  updateOrder,
} = require('./orderDb');
const { processInventoryForOrders } = require('./inventoryService');
const { buildGuardedSnapshotDiff, lockName } = require('./orderSnapshotPolicy');

async function getStoredOrder(tenantId, shopId, orderSn) {
  const [rows] = await db.query(
    'SELECT * FROM orders WHERE tenant_id = ? AND shop_id = ? AND order_sn = ? LIMIT 1',
    [tenantId, shopId, orderSn]
  );
  return rows[0] || null;
}

async function applyShopeeOrderSnapshot({
  tenantId,
  shopId,
  orderRow,
  itemRows,
  source = 'unknown',
}) {
  if (!tenantId || !shopId || !orderRow?.order_sn) {
    throw new Error('tenantId, shopId and orderRow.order_sn are required');
  }

  const lockConn = await db.getConnection();
  const name = lockName(tenantId, shopId, orderRow.order_sn);
  let locked = false;
  try {
    const [lockRows] = await lockConn.query('SELECT GET_LOCK(?, 10) AS acquired', [name]);
    locked = Number(lockRows[0]?.acquired) === 1;
    if (!locked) throw new Error(`order lock timeout: source=${source}`);

    let existing = await getStoredOrder(tenantId, shopId, orderRow.order_sn);
    let created = false;
    if (!existing) {
      const insertResult = await batchInsertOrders([orderRow], { tenantId });
      created = insertResult.inserted === 1;
      existing = await getStoredOrder(tenantId, shopId, orderRow.order_sn);
      if (!existing) throw new Error('order insert did not produce a stored row');
    }

    const previousDisplayStatus = existing.display_status || existing.order_status;
    const previousOrderStatus = existing.order_status;
    const incomingTime = Number(orderRow.update_time || 0);
    const storedTime = Number(existing.update_time || 0);
    let relation = incomingTime > storedTime ? 'newer' : incomingTime < storedTime ? 'stale' : 'equal';
    let updated = false;

    if (!created) {
      const fullDiff = diffOrderRow(existing, orderRow);
      const guarded = buildGuardedSnapshotDiff(existing, orderRow, fullDiff);
      relation = guarded.relation;
      const guardedDiff = guarded.diff;

      if (Object.keys(guardedDiff).length) {
        updated = await updateOrder(orderRow.order_sn, shopId, guardedDiff, {
          tenantId,
          incomingUpdateTime: incomingTime,
          processInventory: false,
        });
      }
    }

    const itemRepair = await repairMissingOrderItems(itemRows || [], { tenantId });
    const supplemented = await supplementOrderFields(orderRow.order_sn, shopId, orderRow, { tenantId });

    const inventoryRelevantUpdate = updated && (
      previousDisplayStatus !== orderRow.display_status ||
      existing.order_status !== orderRow.order_status
    );
    if (created || inventoryRelevantUpdate) {
      await processInventoryForOrders([{ shopId, orderSn: orderRow.order_sn }], { tenantId });
    }

    return {
      created,
      updated,
      stale: relation === 'stale',
      relation,
      repairedItems: itemRepair.inserted,
      supplemented,
      previousDisplayStatus,
      previousOrderStatus,
      displayStatus: existing.display_status === 'TO_RETURN'
        ? 'TO_RETURN'
        : orderRow.display_status,
    };
  } finally {
    if (locked) {
      try { await lockConn.query('SELECT RELEASE_LOCK(?)', [name]); } catch (_) {}
    }
    lockConn.release();
  }
}

module.exports = {
  applyShopeeOrderSnapshot,
};
