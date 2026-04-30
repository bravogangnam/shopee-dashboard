const db = require('../config/database');

const SALE_STOCK_STATUSES = new Set([
  'READY_TO_SHIP',
  'PROCESSED',
  'SHIPPED',
  'COMPLETED',
  'TO_CONFIRM_RECEIVE',
]);

function normalizeSku(value) {
  if (value === null || value === undefined) return null;
  const sku = String(value).trim();
  return sku || null;
}

function getProductSkuForOrderItem(orderItem) {
  return normalizeSku(orderItem?.model_sku) || normalizeSku(orderItem?.item_sku);
}

function parseOrderDate(order) {
  if (order?.order_created_at) return new Date(order.order_created_at);
  if (order?.pay_time) {
    const payTime = Number(order.pay_time);
    if (Number.isFinite(payTime) && payTime > 0) return new Date(payTime * 1000);
  }
  if (order?.create_time) {
    const createTime = Number(order.create_time);
    if (Number.isFinite(createTime) && createTime > 0) return new Date(createTime * 1000);
  }
  if (order?.created_at) return new Date(order.created_at);
  return null;
}

function orderKey(order) {
  return `${order?.shop_id || '-'}:${order?.order_sn || '-'}`;
}

function isDuplicateKeyError(err) {
  return err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
}

function toPositiveQuantity(value) {
  const qty = Number(value);
  return Number.isFinite(qty) && qty > 0 ? Math.trunc(qty) : 0;
}

async function getOrderItems(conn, order) {
  const [items] = await conn.query(
    `SELECT order_sn, shop_id, item_id, item_sku, model_id, model_sku,
            model_quantity_purchased
     FROM order_items
     WHERE order_sn = ? AND shop_id = ?`,
    [order.order_sn, order.shop_id]
  );
  return items;
}

async function getProductForSku(conn, sku) {
  const [rows] = await conn.query(
    `SELECT sku, stock_quantity, stock_tracking_started_at
     FROM products
     WHERE sku = ?
     LIMIT 1`,
    [sku]
  );
  return rows[0] || null;
}

async function saleMovementExists(conn, { orderSn, shopId, sku, itemId, modelId }) {
  const [rows] = await conn.query(
    `SELECT id
     FROM inventory_movements
     WHERE movement_type = 'SALE'
       AND order_sn = ?
       AND shop_id = ?
       AND sku = ?
       AND item_id <=> ?
       AND model_id <=> ?
     LIMIT 1`,
    [orderSn, shopId, sku, itemId ?? null, modelId ?? null]
  );
  return rows.length > 0;
}

async function cancelRestoreMovementExists(conn, saleMovement) {
  const [rows] = await conn.query(
    `SELECT id
     FROM inventory_movements
     WHERE movement_type = 'CANCEL_RESTORE'
       AND order_sn = ?
       AND shop_id = ?
       AND sku = ?
       AND item_id <=> ?
       AND model_id <=> ?
     LIMIT 1`,
    [
      saleMovement.order_sn,
      saleMovement.shop_id,
      saleMovement.sku,
      saleMovement.item_id ?? null,
      saleMovement.model_id ?? null,
    ]
  );
  return rows.length > 0;
}

async function insertMovement(conn, movement) {
  const [result] = await conn.query(
    `INSERT INTO inventory_movements
       (sku, order_sn, shop_id, item_id, model_id, movement_type, qty_delta, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      movement.sku,
      movement.order_sn ?? null,
      movement.shop_id ?? null,
      movement.item_id ?? null,
      movement.model_id ?? null,
      movement.movement_type,
      movement.qty_delta,
      movement.note ?? null,
    ]
  );
  return result.insertId;
}

async function applySaleMovementForOrder(order) {
  if (!order?.order_sn || !order?.shop_id) return;
  if (order.order_status === 'CANCELLED') return;
  if (!SALE_STOCK_STATUSES.has(order.order_status)) return;

  const conn = await db.getConnection();
  try {
    const items = await getOrderItems(conn, order);
    const orderDate = parseOrderDate(order);

    for (const item of items) {
      const sku = getProductSkuForOrderItem(item);
      if (!sku) {
        console.warn(`[Inventory] SKU 없음 스킵: 주문=${orderKey(order)} item=${item.item_id || '-'} model=${item.model_id || '-'}`);
        continue;
      }

      const product = await getProductForSku(conn, sku);
      if (!product) {
        console.warn(`[Inventory] product 없음 스킵: sku=${sku}, 주문=${orderKey(order)}`);
        continue;
      }

      if (!product.stock_tracking_started_at) {
        console.log(`[Inventory] tracking 시작일 없음 스킵: sku=${sku}, 주문=${orderKey(order)}`);
        continue;
      }

      const trackingStartedAt = new Date(product.stock_tracking_started_at);
      if (orderDate && orderDate < trackingStartedAt) {
        console.log(`[Inventory] tracking 시작 전 주문 스킵: sku=${sku}, 주문=${orderKey(order)}, orderDate=${orderDate.toISOString()}`);
        continue;
      }

      const quantity = toPositiveQuantity(item.model_quantity_purchased);
      if (!quantity) {
        console.warn(`[Inventory] 수량 없음 스킵: sku=${sku}, 주문=${orderKey(order)}`);
        continue;
      }

      const movementKey = {
        orderSn: order.order_sn,
        shopId: order.shop_id,
        sku,
        itemId: item.item_id ?? 0,
        modelId: item.model_id ?? 0,
      };

      const exists = await saleMovementExists(conn, movementKey);
      if (exists) {
        console.log(`[Inventory] 중복 SALE movement 스킵: sku=${sku}, 주문=${orderKey(order)}`);
        continue;
      }

      try {
        await conn.beginTransaction();
        const existsInTx = await saleMovementExists(conn, movementKey);
        if (existsInTx) {
          await conn.rollback();
          console.log(`[Inventory] 중복 SALE movement 스킵: sku=${sku}, 주문=${orderKey(order)}`);
          continue;
        }

        await insertMovement(conn, {
          sku,
          order_sn: order.order_sn,
          shop_id: order.shop_id,
          item_id: movementKey.itemId,
          model_id: movementKey.modelId,
          movement_type: 'SALE',
          qty_delta: -quantity,
          note: `Order sale ${order.order_sn}`,
        });
        await conn.query(
          `UPDATE products
           SET stock_quantity = stock_quantity - ?
           WHERE sku = ?`,
          [quantity, sku]
        );
        await conn.commit();
        console.log(`[Inventory] SALE movement 생성: sku=${sku}, qty=-${quantity}, 주문=${orderKey(order)}`);
      } catch (err) {
        await conn.rollback();
        if (isDuplicateKeyError(err)) {
          console.log(`[Inventory] 중복 SALE movement 스킵: sku=${sku}, 주문=${orderKey(order)}`);
          continue;
        }
        console.error(`[Inventory] SALE movement 오류: sku=${sku}, 주문=${orderKey(order)}: ${err.message}`);
        throw err;
      }
    }
  } finally {
    conn.release();
  }
}

async function restoreCancelledOrder(order) {
  if (!order?.order_sn || !order?.shop_id || order.order_status !== 'CANCELLED') return;

  const conn = await db.getConnection();
  try {
    const [saleMovements] = await conn.query(
      `SELECT *
       FROM inventory_movements
       WHERE movement_type = 'SALE'
         AND order_sn = ?
         AND shop_id = ?`,
      [order.order_sn, order.shop_id]
    );

    if (!saleMovements.length) {
      console.log(`[Inventory] CANCEL_RESTORE 스킵: 기존 SALE movement 없음, 주문=${orderKey(order)}`);
      return;
    }

    for (const saleMovement of saleMovements) {
      const exists = await cancelRestoreMovementExists(conn, saleMovement);
      if (exists) {
        console.log(`[Inventory] 중복 CANCEL_RESTORE movement 스킵: sku=${saleMovement.sku}, 주문=${orderKey(order)}`);
        continue;
      }

      const restoreQty = Math.abs(Number(saleMovement.qty_delta || 0));
      if (!restoreQty) continue;

      try {
        await conn.beginTransaction();
        const existsInTx = await cancelRestoreMovementExists(conn, saleMovement);
        if (existsInTx) {
          await conn.rollback();
          console.log(`[Inventory] 중복 CANCEL_RESTORE movement 스킵: sku=${saleMovement.sku}, 주문=${orderKey(order)}`);
          continue;
        }

        await insertMovement(conn, {
          sku: saleMovement.sku,
          order_sn: saleMovement.order_sn,
          shop_id: saleMovement.shop_id,
          item_id: saleMovement.item_id,
          model_id: saleMovement.model_id,
          movement_type: 'CANCEL_RESTORE',
          qty_delta: restoreQty,
          note: `Cancel restore ${order.order_sn}`,
        });
        await conn.query(
          `UPDATE products
           SET stock_quantity = stock_quantity + ?
           WHERE sku = ?`,
          [restoreQty, saleMovement.sku]
        );
        await conn.commit();
        console.log(`[Inventory] CANCEL_RESTORE movement 생성: sku=${saleMovement.sku}, qty=+${restoreQty}, 주문=${orderKey(order)}`);
      } catch (err) {
        await conn.rollback();
        if (isDuplicateKeyError(err)) {
          console.log(`[Inventory] 중복 CANCEL_RESTORE movement 스킵: sku=${saleMovement.sku}, 주문=${orderKey(order)}`);
          continue;
        }
        console.error(`[Inventory] CANCEL_RESTORE movement 오류: sku=${saleMovement.sku}, 주문=${orderKey(order)}: ${err.message}`);
        throw err;
      }
    }
  } finally {
    conn.release();
  }
}

async function processInventoryForOrder(order) {
  try {
    const { isInventoryFifoEnabled, allocateSaleInventoryForOrder } = require('./inventoryFifoService');
    if (!isInventoryFifoEnabled()) return;
    if (order.order_status === 'CANCELLED') return;
    if (SALE_STOCK_STATUSES.has(order.order_status)) {
      await allocateSaleInventoryForOrder(order);
    }
    return;
  } catch (err) {
    console.error(`[Inventory] 주문 재고 처리 오류: 주문=${orderKey(order)}: ${err.message}`);
  }
}

async function processInventoryForOrders(orderKeys) {
  const uniqueKeys = Array.from(
    new Map(
      orderKeys
        .filter(key => key?.shopId !== undefined && key?.shopId !== null && key?.orderSn)
        .map(key => [`${key.shopId}::${key.orderSn}`, key])
    ).values()
  );

  if (!uniqueKeys.length) return;

  const whereClauses = uniqueKeys.map(() => '(shop_id = ? AND order_sn = ?)').join(' OR ');
  const params = [];
  for (const key of uniqueKeys) {
    params.push(key.shopId, key.orderSn);
  }

  const [orders] = await db.query(
    `SELECT order_sn, shop_id, order_status, order_created_at, create_time
     FROM orders
     WHERE ${whereClauses}`,
    params
  );

  for (const order of orders) {
    await processInventoryForOrder(order);
  }
}

async function manuallyAdjustStock({ sku, qty_delta, note }) {
  const normalizedSku = normalizeSku(sku);
  const qtyDelta = Number(qty_delta);
  if (!normalizedSku) throw new Error('sku is required');
  if (!Number.isFinite(qtyDelta) || qtyDelta === 0) throw new Error('qty_delta must be a non-zero number');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `UPDATE products
       SET stock_quantity = stock_quantity + ?
       WHERE sku = ?`,
      [Math.trunc(qtyDelta), normalizedSku]
    );
    if (result.affectedRows === 0) {
      throw new Error(`Product not found: ${normalizedSku}`);
    }

    await insertMovement(conn, {
      sku: normalizedSku,
      movement_type: 'MANUAL_ADJUST',
      qty_delta: Math.trunc(qtyDelta),
      note: note || null,
    });
    await conn.commit();
    console.log(`[Inventory] MANUAL_ADJUST movement 생성: sku=${normalizedSku}, qty=${Math.trunc(qtyDelta)}, note=${note || '-'}`);
  } catch (err) {
    await conn.rollback();
    console.error(`[Inventory] MANUAL_ADJUST 오류: sku=${normalizedSku}: ${err.message}`);
    throw err;
  } finally {
    conn.release();
  }
}

function toNonNegativeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return number;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function truncateNote(value) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 255);
}

async function getProductStockForUpdate(conn, sku) {
  const [rows] = await conn.query(
    `SELECT sku, stock_quantity
     FROM products
     WHERE sku = ?
     LIMIT 1
     FOR UPDATE`,
    [sku]
  );
  return rows[0] || null;
}

async function buildStartBalanceAllocationPlan(conn, sku, adjustQty) {
  const [batches] = await conn.query(
    `SELECT id, sku, remaining_qty, unit_cost, received_at
     FROM inventory_batches
     WHERE sku = ?
       AND remaining_qty > 0
     ORDER BY received_at IS NULL, received_at ASC, id ASC
     FOR UPDATE`,
    [sku]
  );

  let remainingToAdjust = adjustQty;
  let allocatedQty = 0;
  const allocations = [];

  for (const batch of batches) {
    if (remainingToAdjust <= 0) break;

    const availableQty = Number(batch.remaining_qty || 0);
    if (availableQty <= 0) continue;

    const qty = Math.min(remainingToAdjust, availableQty);
    const unitCost = Number(batch.unit_cost || 0);
    const totalCost = roundMoney(qty * unitCost);

    allocations.push({
      batchId: batch.id,
      sku,
      qty,
      unitCost,
      totalCost,
    });
    remainingToAdjust -= qty;
    allocatedQty += qty;
  }

  const shortageQty = Math.max(0, adjustQty - allocatedQty);
  if (shortageQty > 0) {
    throw new Error(
      `Insufficient FIFO batch balance for start adjustment: sku=${sku}, required=${adjustQty}, allocated=${allocatedQty}, shortage=${shortageQty}`
    );
  }

  return allocations;
}

async function adjustStartBalanceStock({ sku, target_stock_quantity, note }) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) throw new Error('sku is required');

  const targetStockQuantity = toNonNegativeInteger(target_stock_quantity, 'target_stock_quantity');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const product = await getProductStockForUpdate(conn, normalizedSku);
    if (!product) {
      throw new Error(`Product not found: ${normalizedSku}`);
    }

    const previousStockQuantity = toNonNegativeInteger(product.stock_quantity, 'current stock_quantity');
    if (targetStockQuantity > previousStockQuantity) {
      throw new Error('target_stock_quantity cannot exceed current stock; use inventory receipt sync for stock increases');
    }

    if (targetStockQuantity === previousStockQuantity) {
      await conn.commit();
      return {
        sku: normalizedSku,
        previous_stock_quantity: previousStockQuantity,
        target_stock_quantity: targetStockQuantity,
        adjusted_qty: 0,
        movement_id: null,
        allocations: [],
        noop: true,
      };
    }

    const adjustQty = previousStockQuantity - targetStockQuantity;
    const allocations = await buildStartBalanceAllocationPlan(conn, normalizedSku, adjustQty);
    const movementNote = truncateNote(
      `START_BALANCE_ADJUST; previous=${previousStockQuantity}; target=${targetStockQuantity}; adjusted=-${adjustQty}; note=${note || ''}`
    );

    const movementId = await insertMovement(conn, {
      sku: normalizedSku,
      movement_type: 'MANUAL_ADJUST',
      qty_delta: -adjustQty,
      note: movementNote,
    });

    for (const allocation of allocations) {
      const [batchUpdate] = await conn.query(
        `UPDATE inventory_batches
         SET remaining_qty = remaining_qty - ?
         WHERE id = ?
           AND remaining_qty >= ?`,
        [allocation.qty, allocation.batchId, allocation.qty]
      );
      if (batchUpdate.affectedRows !== 1) {
        throw new Error(`FIFO batch update failed: batch_id=${allocation.batchId}`);
      }

      await conn.query(
        `INSERT INTO inventory_allocations
           (movement_id, batch_id, order_sn, shop_id, source_sku, sku,
            qty, unit_cost, total_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movementId,
          allocation.batchId,
          null,
          null,
          normalizedSku,
          normalizedSku,
          allocation.qty,
          allocation.unitCost,
          allocation.totalCost,
        ]
      );
    }

    const [productUpdate] = await conn.query(
      `UPDATE products
       SET stock_quantity = ?
       WHERE sku = ?`,
      [targetStockQuantity, normalizedSku]
    );
    if (productUpdate.affectedRows !== 1) {
      throw new Error(`Product stock update failed: ${normalizedSku}`);
    }

    await conn.commit();
    console.log(
      `[Inventory] START_BALANCE_ADJUST created: sku=${normalizedSku}, previous=${previousStockQuantity}, target=${targetStockQuantity}, adjusted=-${adjustQty}`
    );

    return {
      sku: normalizedSku,
      previous_stock_quantity: previousStockQuantity,
      target_stock_quantity: targetStockQuantity,
      adjusted_qty: adjustQty,
      movement_id: movementId,
      allocations,
    };
  } catch (err) {
    await conn.rollback();
    console.error(`[Inventory] START_BALANCE_ADJUST error: sku=${normalizedSku}: ${err.message}`);
    throw err;
  } finally {
    conn.release();
  }
}

async function getLowStockProducts() {
  const [rows] = await db.query(
    `SELECT sku, brand, product_name_kr, product_name_en, option_name,
            stock_quantity, low_stock_threshold, stock_tracking_started_at
     FROM products
     WHERE stock_quantity <= low_stock_threshold
     ORDER BY stock_quantity ASC, sku ASC`
  );
  return rows;
}

async function updateProductStockSettings(sku, data) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) throw new Error('sku is required');

  const allowedFields = [
    'stock_quantity',
    'low_stock_threshold',
    'stock_tracking_started_at',
  ];
  const updates = [];
  const params = [];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      updates.push(`${field} = ?`);
      params.push(data[field] === '' ? null : data[field]);
    }
  }

  if (!updates.length) throw new Error('No stock fields provided');

  params.push(normalizedSku);
  const [result] = await db.query(
    `UPDATE products
     SET ${updates.join(', ')}, updated_at = NOW()
     WHERE sku = ?`,
    params
  );

  if (result.affectedRows === 0) {
    throw new Error(`Product not found: ${normalizedSku}`);
  }
}

async function getInventoryMovements(sku, limit = 100) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) throw new Error('sku is required');
  const safeLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const [rows] = await db.query(
    `SELECT id, sku, order_sn, shop_id, item_id, model_id, movement_type,
            qty_delta, note, created_at
     FROM inventory_movements
     WHERE sku = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [normalizedSku, safeLimit]
  );
  return rows;
}

module.exports = {
  SALE_STOCK_STATUSES,
  normalizeSku,
  isDuplicateKeyError,
  insertInventoryMovement: insertMovement,
  getProductSkuForOrderItem,
  applySaleMovementForOrder,
  restoreCancelledOrder,
  processInventoryForOrder,
  processInventoryForOrders,
  manuallyAdjustStock,
  adjustStartBalanceStock,
  getLowStockProducts,
  updateProductStockSettings,
  getInventoryMovements,
};
