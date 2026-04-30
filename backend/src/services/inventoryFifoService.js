const { normalizeSku } = require('./inventoryService');

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function toPositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return Math.trunc(number);
}

async function getExistingAllocations(conn, movementId) {
  const [rows] = await conn.query(
    `SELECT id, movement_id, batch_id, order_sn, shop_id, source_sku, sku,
            qty, unit_cost, total_cost, created_at
     FROM inventory_allocations
     WHERE movement_id = ?
     ORDER BY id ASC`,
    [movementId]
  );
  return rows;
}

function summarizeExistingAllocations(requestedQty, rows) {
  const allocatedQty = rows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const totalCost = rows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0);
  return {
    requestedQty,
    allocatedQty,
    shortageQty: Math.max(0, requestedQty - allocatedQty),
    totalCost: roundMoney(totalCost),
    allocations: rows.map(row => ({
      id: row.id,
      movementId: row.movement_id,
      batchId: row.batch_id,
      orderSn: row.order_sn,
      shopId: row.shop_id,
      sourceSku: row.source_sku,
      sku: row.sku,
      qty: Number(row.qty || 0),
      unitCost: Number(row.unit_cost || 0),
      totalCost: Number(row.total_cost || 0),
      createdAt: row.created_at,
    })),
    alreadyAllocated: true,
  };
}

async function allocateInventoryFifo(conn, {
  movementId,
  orderSn = null,
  shopId = null,
  sourceSku = null,
  baseSku,
  qty,
}) {
  if (!movementId) throw new Error('movementId is required');
  const normalizedBaseSku = normalizeSku(baseSku);
  if (!normalizedBaseSku) throw new Error('baseSku is required');
  const requestedQty = toPositiveInteger(qty, 'qty');

  const existingAllocations = await getExistingAllocations(conn, movementId);
  if (existingAllocations.length) {
    return summarizeExistingAllocations(requestedQty, existingAllocations);
  }

  const [batches] = await conn.query(
    `SELECT id, sku, remaining_qty, unit_cost, received_at
     FROM inventory_batches
     WHERE sku = ?
       AND remaining_qty > 0
     ORDER BY received_at IS NULL, received_at ASC, id ASC
     FOR UPDATE`,
    [normalizedBaseSku]
  );

  let remainingToAllocate = requestedQty;
  let allocatedQty = 0;
  let totalCost = 0;
  const allocations = [];

  for (const batch of batches) {
    if (remainingToAllocate <= 0) break;

    const availableQty = Number(batch.remaining_qty || 0);
    if (availableQty <= 0) continue;

    const allocationQty = Math.min(remainingToAllocate, availableQty);
    const unitCost = Number(batch.unit_cost || 0);
    const allocationCost = roundMoney(allocationQty * unitCost);

    const [updateResult] = await conn.query(
      `UPDATE inventory_batches
       SET remaining_qty = remaining_qty - ?
       WHERE id = ?
         AND remaining_qty >= ?`,
      [allocationQty, batch.id, allocationQty]
    );
    if (updateResult.affectedRows !== 1) {
      throw new Error(`FIFO batch update failed: batch_id=${batch.id}`);
    }

    await conn.query(
      `INSERT INTO inventory_allocations
         (movement_id, batch_id, order_sn, shop_id, source_sku, sku,
          qty, unit_cost, total_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        movementId,
        batch.id,
        orderSn,
        shopId,
        normalizeSku(sourceSku),
        normalizedBaseSku,
        allocationQty,
        unitCost,
        allocationCost,
      ]
    );

    remainingToAllocate -= allocationQty;
    allocatedQty += allocationQty;
    totalCost += allocationCost;
    allocations.push({
      movementId,
      batchId: batch.id,
      orderSn,
      shopId,
      sourceSku: normalizeSku(sourceSku),
      sku: normalizedBaseSku,
      qty: allocationQty,
      unitCost,
      totalCost: allocationCost,
    });
  }

  return {
    requestedQty,
    allocatedQty,
    shortageQty: Math.max(0, requestedQty - allocatedQty),
    totalCost: roundMoney(totalCost),
    allocations,
    alreadyAllocated: false,
  };
}

module.exports = {
  allocateInventoryFifo,
};
