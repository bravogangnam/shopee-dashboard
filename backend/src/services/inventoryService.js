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

function mysqlDateTime(date) {
  const pad = value => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join('-') + ' ' + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join(':');
}

function getTodayKstUtcRange(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const startUtcMs = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 60 * 60 * 1000;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;
  return {
    start: mysqlDateTime(new Date(startUtcMs)),
    end: mysqlDateTime(new Date(endUtcMs)),
  };
}

function stockStatus(stockQuantity, lowStockThreshold) {
  const stock = Number(stockQuantity || 0);
  const threshold = Number(lowStockThreshold || 0);
  if (stock < 0) return 'purchase_needed';
  if (stock === 0) return 'out_of_stock';
  if (stock > 0 && stock <= threshold) return 'low_stock';
  return 'in_stock';
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

async function getInventoryProducts({ scope = 'low-stock' } = {}) {
  const whereClause = scope === 'all'
    ? ''
    : 'WHERE stock_quantity <= COALESCE(low_stock_threshold, 0)';

  const [rows] = await db.query(
    `SELECT sku, brand, product_name_kr, product_name_en, option_name,
            stock_quantity, low_stock_threshold, stock_tracking_started_at
     FROM products
     ${whereClause}
     ORDER BY stock_quantity ASC, sku ASC`
  );
  return rows;
}

async function getInventorySummary() {
  const [productRows] = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN stock_quantity < 0 THEN 1 ELSE 0 END), 0) AS purchase_needed_sku_count,
       COALESCE(SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count,
       COALESCE(SUM(CASE WHEN stock_quantity > 0 AND stock_quantity <= COALESCE(low_stock_threshold, 0) THEN 1 ELSE 0 END), 0) AS low_stock_count,
       COALESCE(SUM(CASE WHEN stock_quantity > 0 THEN 1 ELSE 0 END), 0) AS in_stock_sku_count,
       COALESCE(SUM(stock_quantity), 0) AS total_stock_quantity
     FROM products`
  );
  const [valueRows] = await db.query(
    `SELECT COALESCE(SUM(remaining_qty * unit_cost * 1.1), 0) AS total_inventory_value
     FROM inventory_batches`
  );

  return {
    purchase_needed_sku_count: Number(productRows[0]?.purchase_needed_sku_count || 0),
    out_of_stock_count: Number(productRows[0]?.out_of_stock_count || 0),
    low_stock_count: Number(productRows[0]?.low_stock_count || 0),
    in_stock_sku_count: Number(productRows[0]?.in_stock_sku_count || 0),
    total_stock_quantity: Number(productRows[0]?.total_stock_quantity || 0),
    total_inventory_value: Number(valueRows[0]?.total_inventory_value || 0),
  };
}

async function getLowStockProducts() {
  return getInventoryProducts();
}

async function getTodayOrderInventory() {
  const { start, end } = getTodayKstUtcRange();
  const [orderItems] = await db.query(
    `SELECT
       o.order_sn,
       o.shop_id,
       o.order_created_at,
       oi.item_id,
       oi.model_id,
       oi.item_name,
       oi.item_sku,
       oi.model_name,
       oi.model_sku,
       oi.model_quantity_purchased,
       oi.image_info_image_url,
       oi.item_image_url
     FROM orders o
     INNER JOIN order_items oi
       ON oi.order_sn = o.order_sn
      AND oi.shop_id = o.shop_id
     INNER JOIN shops s
       ON s.shop_id = o.shop_id
      AND s.is_active = 1
     WHERE o.order_status IN ('READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED')
       AND o.order_created_at >= ?
       AND o.order_created_at < ?
     ORDER BY o.order_created_at DESC, o.order_sn ASC, oi.id ASC`,
    [start, end]
  );

  const componentCache = new Map();
  const aggregates = new Map();

  async function componentsFor(sourceSku) {
    if (!componentCache.has(sourceSku)) {
      const [rows] = await db.query(
        `SELECT source_sku, base_sku, factor, composition_type, note
         FROM sku_compositions
         WHERE source_sku = ?
         ORDER BY id ASC`,
        [sourceSku]
      );
      componentCache.set(sourceSku, rows.length
        ? rows.map(row => ({
          sourceSku: row.source_sku,
          baseSku: row.base_sku,
          factor: Number(row.factor || 0),
          type: row.composition_type || null,
          note: row.note || null,
        }))
        : [{ sourceSku, baseSku: sourceSku, factor: 1, type: 'default', note: '' }]);
    }
    return componentCache.get(sourceSku);
  }

  for (const item of orderItems) {
    const sourceSku = getProductSkuForOrderItem(item);
    const itemQty = toPositiveQuantity(item.model_quantity_purchased);
    if (!sourceSku || !itemQty) continue;

    const components = await componentsFor(sourceSku);
    for (const component of components) {
      const factor = Number(component.factor || 0);
      if (!component.baseSku || factor <= 0) continue;

      const baseQty = itemQty * factor;
      const existing = aggregates.get(component.baseSku) || {
        sku: component.baseSku,
        ordered_qty: 0,
        orderMap: new Map(),
        sourceNames: [],
        image_url: null,
        last_order_created_at: null,
      };

      existing.ordered_qty += baseQty;
      existing.sourceNames.push(item.item_name);
      existing.image_url = existing.image_url || item.image_info_image_url || item.item_image_url || null;
      if (!existing.last_order_created_at || new Date(item.order_created_at) > new Date(existing.last_order_created_at)) {
        existing.last_order_created_at = item.order_created_at;
      }

      const orderLine = existing.orderMap.get(item.order_sn) || {
        order_sn: item.order_sn,
        qty: 0,
      };
      orderLine.qty += baseQty;
      existing.orderMap.set(item.order_sn, orderLine);
      aggregates.set(component.baseSku, existing);
    }
  }

  const skus = Array.from(aggregates.keys());
  if (!skus.length) {
    return {
      data: [],
      summary: {
        sku_count: 0,
        purchase_needed_sku_count: 0,
        purchase_needed_total_qty: 0,
      },
    };
  }

  const placeholders = skus.map(() => '?').join(',');
  const [products] = await db.query(
    `SELECT sku, brand, product_name_kr, product_name_en, option_name,
            stock_quantity, low_stock_threshold, stock_tracking_started_at
     FROM products
     WHERE sku IN (${placeholders})`,
    skus
  );
  const productMap = new Map(products.map(product => [product.sku, product]));

  const [batchRows] = await db.query(
    `SELECT sku, unit_cost
     FROM inventory_batches
     WHERE sku IN (${placeholders})
     ORDER BY sku ASC, received_at IS NULL, received_at DESC, id DESC`,
    skus
  );
  const latestCostMap = new Map();
  for (const batch of batchRows) {
    if (!latestCostMap.has(batch.sku) && Number(batch.unit_cost || 0) > 0) {
      latestCostMap.set(batch.sku, Number(batch.unit_cost || 0) * 1.1);
    }
  }

  const data = Array.from(aggregates.values()).map(row => {
    const product = productMap.get(row.sku) || {};
    const stockQuantity = Number(product.stock_quantity || 0);
    const lowStockThreshold = Number(product.low_stock_threshold || 0);
    const orderLines = Array.from(row.orderMap.values())
      .sort((a, b) => String(a.order_sn).localeCompare(String(b.order_sn)));
    const fallbackName = row.sourceNames.find(Boolean) || row.sku;

    return {
      sku: row.sku,
      product_name: product.product_name_kr || product.product_name || fallbackName,
      product_name_kr: product.product_name_kr || null,
      product_name_en: product.product_name_en || null,
      ordered_qty: row.ordered_qty,
      order_count: orderLines.length,
      order_sns: orderLines.map(line => line.order_sn),
      order_lines: orderLines,
      stock_quantity: stockQuantity,
      low_stock_threshold: lowStockThreshold,
      status: stockStatus(stockQuantity, lowStockThreshold),
      purchase_needed_qty: stockQuantity < 0 ? Math.abs(stockQuantity) : 0,
      latest_unit_cost_vat: latestCostMap.get(row.sku) || null,
      image_url: row.image_url,
      last_order_created_at: row.last_order_created_at,
    };
  });

  const statusRank = {
    purchase_needed: 0,
    out_of_stock: 1,
    low_stock: 2,
    in_stock: 3,
  };

  data.sort((a, b) => {
    if (b.purchase_needed_qty !== a.purchase_needed_qty) {
      return b.purchase_needed_qty - a.purchase_needed_qty;
    }
    if (statusRank[a.status] !== statusRank[b.status]) {
      return statusRank[a.status] - statusRank[b.status];
    }
    return new Date(b.last_order_created_at || 0) - new Date(a.last_order_created_at || 0);
  });

  return {
    data,
    summary: {
      sku_count: data.length,
      purchase_needed_sku_count: data.filter(item => item.stock_quantity < 0).length,
      purchase_needed_total_qty: data.reduce((sum, item) => sum + Number(item.purchase_needed_qty || 0), 0),
    },
  };
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
  getInventoryProducts,
  getInventorySummary,
  getTodayOrderInventory,
  getLowStockProducts,
  updateProductStockSettings,
  getInventoryMovements,
};
