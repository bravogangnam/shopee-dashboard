const {
  SALE_STOCK_STATUSES,
  getProductSkuForOrderItem,
  insertInventoryMovement,
  isDuplicateKeyError,
  normalizeSku,
} = require('./inventoryService');
const { getSkuComponents } = require('./skuCompositionService');

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

function isInventoryFifoEnabled() {
  return String(process.env.INVENTORY_FIFO_ENABLED || '').trim() === 'true';
}

function toPositiveQuantity(value) {
  const qty = Number(value);
  return Number.isFinite(qty) && qty > 0 ? Math.trunc(qty) : 0;
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

async function getProductTrackingInfo(conn, sku) {
  const [rows] = await conn.query(
    `SELECT sku, stock_tracking_started_at
     FROM products
     WHERE sku = ?
     LIMIT 1`,
    [sku]
  );
  return rows[0] || null;
}

async function shouldSkipByTrackingStart(conn, order, baseSku) {
  const product = await getProductTrackingInfo(conn, baseSku);
  if (!product) {
    console.warn(`[InventoryFIFO] product not found, skip sale allocation: order=${order.order_sn}, shop=${order.shop_id}, baseSku=${baseSku}`);
    return true;
  }

  if (!product.stock_tracking_started_at) {
    console.log(`[InventoryFIFO] tracking start not set, skip sale allocation: order=${order.order_sn}, shop=${order.shop_id}, baseSku=${baseSku}`);
    return true;
  }

  const orderDate = parseOrderDate(order);
  const trackingStartedAt = new Date(product.stock_tracking_started_at);
  if (orderDate && orderDate < trackingStartedAt) {
    console.log(`[InventoryFIFO] order before tracking start, skip sale allocation: order=${order.order_sn}, shop=${order.shop_id}, baseSku=${baseSku}, orderDate=${orderDate.toISOString()}, trackingStartedAt=${trackingStartedAt.toISOString()}`);
    return true;
  }

  return false;
}

async function getOrderItemsForInventory(conn, order) {
  const [items] = await conn.query(
    `SELECT order_sn, shop_id, item_id, item_sku, model_id, model_sku,
            model_quantity_purchased
     FROM order_items
     WHERE order_sn = ? AND shop_id = ?
     ORDER BY id ASC`,
    [order.order_sn, order.shop_id]
  );
  return items;
}

async function saleMovementExists(conn, { orderSn, shopId, sku, itemId, modelId }) {
  const [rows] = await conn.query(
    `SELECT id, qty_delta
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
  return rows[0] || null;
}

async function insertSaleMovement(conn, {
  orderSn,
  shopId,
  itemId,
  modelId,
  sourceSku,
  baseSku,
  requiredQty,
}) {
  await insertInventoryMovement(conn, {
    sku: baseSku,
    order_sn: orderSn,
    shop_id: shopId,
    item_id: itemId ?? null,
    model_id: modelId ?? null,
    movement_type: 'SALE',
    qty_delta: -requiredQty,
    note: sourceSku === baseSku
      ? `FIFO sale ${orderSn}`
      : `FIFO sale ${orderSn}; source_sku=${sourceSku}`,
  });

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
    [orderSn, shopId, baseSku, itemId ?? null, modelId ?? null]
  );

  return rows[0]?.id || null;
}

async function decrementProductStock(conn, sku, allocatedQty) {
  if (!allocatedQty) return;
  const [result] = await conn.query(
    `UPDATE products
     SET stock_quantity = GREATEST(stock_quantity - ?, 0)
     WHERE sku = ?`,
    [allocatedQty, sku]
  );
  if (result.affectedRows === 0) {
    console.warn(`[InventoryFIFO] product not found for stock decrement: sku=${sku}, allocatedQty=${allocatedQty}`);
  }
}

async function allocateSaleInventoryForOrderItem(conn, order, item) {
  const sourceSku = getProductSkuForOrderItem(item);
  if (!sourceSku) {
    console.warn(`[InventoryFIFO] skip item without SKU: order=${order.order_sn}, shop=${order.shop_id}, item=${item.item_id || '-'}`);
    return { skipped: true, reason: 'missing_sku' };
  }

  const itemQty = toPositiveQuantity(item.model_quantity_purchased);
  if (!itemQty) {
    console.warn(`[InventoryFIFO] skip item without quantity: order=${order.order_sn}, shop=${order.shop_id}, sourceSku=${sourceSku}`);
    return { skipped: true, reason: 'missing_quantity' };
  }

  const components = await getSkuComponents(conn, sourceSku);
  const results = [];

  for (const component of components) {
    const factor = Number(component.factor || 0);
    const baseSku = normalizeSku(component.baseSku);
    const requiredQty = itemQty * factor;

    if (!baseSku || !factor || factor <= 0 || !Number.isInteger(requiredQty)) {
      console.warn(`[InventoryFIFO] invalid component skipped: order=${order.order_sn}, shop=${order.shop_id}, sourceSku=${sourceSku}, baseSku=${baseSku || '-'}, factor=${factor}`);
      results.push({ skipped: true, reason: 'invalid_component', sourceSku, baseSku, requiredQty });
      continue;
    }

    if (await shouldSkipByTrackingStart(conn, order, baseSku)) {
      results.push({ skipped: true, reason: 'tracking_not_started', sourceSku, baseSku, requiredQty });
      continue;
    }

    const movementKey = {
      orderSn: order.order_sn,
      shopId: order.shop_id,
      sku: baseSku,
      itemId: item.item_id ?? 0,
      modelId: item.model_id ?? 0,
    };

    const existingMovement = await saleMovementExists(conn, movementKey);
    if (existingMovement) {
      console.log(`[InventoryFIFO] duplicate SALE movement skipped: order=${order.order_sn}, shop=${order.shop_id}, sourceSku=${sourceSku}, baseSku=${baseSku}`);
      results.push({ skipped: true, reason: 'duplicate_sale', sourceSku, baseSku, requiredQty });
      continue;
    }

    const movementId = await insertSaleMovement(conn, {
      orderSn: order.order_sn,
      shopId: order.shop_id,
      itemId: movementKey.itemId,
      modelId: movementKey.modelId,
      sourceSku,
      baseSku,
      requiredQty,
    });

    const allocation = await allocateInventoryFifo(conn, {
      movementId,
      orderSn: order.order_sn,
      shopId: order.shop_id,
      sourceSku,
      baseSku,
      qty: requiredQty,
    });

    await decrementProductStock(conn, baseSku, allocation.allocatedQty);

    if (allocation.shortageQty > 0) {
      console.warn(
        `[InventoryFIFO] shortage: order=${order.order_sn}, shop=${order.shop_id}, sourceSku=${sourceSku}, baseSku=${baseSku}, required=${requiredQty}, allocated=${allocation.allocatedQty}, shortage=${allocation.shortageQty}`
      );
    } else {
      console.log(`[InventoryFIFO] allocated: order=${order.order_sn}, shop=${order.shop_id}, sourceSku=${sourceSku}, baseSku=${baseSku}, qty=${allocation.allocatedQty}`);
    }

    results.push({ sourceSku, baseSku, requiredQty, ...allocation });
  }

  return { sourceSku, itemQty, results };
}

async function allocateSaleInventoryForOrder(order, conn) {
  if (!isInventoryFifoEnabled()) return;
  if (!order?.order_sn || !order?.shop_id) return;
  if (!SALE_STOCK_STATUSES.has(order.order_status)) return;
  if (order.order_status === 'CANCELLED') return;

  const ownsConnection = !conn;
  const workConn = conn || await require('../config/database').getConnection();

  try {
    if (ownsConnection) await workConn.beginTransaction();

    const items = await getOrderItemsForInventory(workConn, order);
    for (const item of items) {
      await allocateSaleInventoryForOrderItem(workConn, order, item);
    }

    if (ownsConnection) await workConn.commit();
  } catch (err) {
    if (ownsConnection) await workConn.rollback();
    if (isDuplicateKeyError(err)) {
      console.log(`[InventoryFIFO] duplicate movement/allocation skipped after race: order=${order.order_sn}, shop=${order.shop_id}`);
      return;
    }
    throw err;
  } finally {
    if (ownsConnection) workConn.release();
  }
}

module.exports = {
  isInventoryFifoEnabled,
  allocateInventoryFifo,
  allocateSaleInventoryForOrder,
  allocateSaleInventoryForOrderItem,
};
