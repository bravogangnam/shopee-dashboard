const express = require('express');
const router = express.Router();

const db = require('../config/database');
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const { getCurrentTenantId } = require('../config/tenant');
const { allocateOpenShortagesForBatch } = require('../services/inventoryFifoService');

router.use(requireAuth);
router.use(requireApprovedTenant);

function likeKeyword(keyword) {
  const text = String(keyword || '').trim();
  return text ? `%${text}%` : null;
}


function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function todayDateKst() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function mysqlDateTime(date = new Date()) {
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

function parsePositiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
}

function parseSupplyRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return number > 1 ? number / 100 : number;
}

function computeCosts({ priceVatIncluded, supplyRate }) {
  const priceVat = Number(priceVatIncluded || 0);
  const rate = parseSupplyRate(supplyRate);
  const unitPriceVatIncluded = roundMoney(priceVat * rate);
  const unitCost = roundMoney(unitPriceVatIncluded / 1.1);
  return { supplyRate: rate, unitPriceVatIncluded, unitCost };
}

function makeReceiptCode({ sku, dateText }) {
  const safeSku = String(sku || '').replace(/[^A-Za-z0-9_]/g, '');
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `DB-${dateText.replace(/-/g, '')}-${safeSku}-${stamp}`;
}

async function getProductBySku(connOrPool, tenantId, sku) {
  const [rows] = await connOrPool.query(
    `SELECT sku, product_name_kr, product_name_en, option_name, stock_quantity
     FROM products
     WHERE tenant_id = ?
       AND sku = ?
     LIMIT 1`,
    [tenantId, sku]
  );
  return rows[0] || null;
}


function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeInputSku(value) {
  return cleanText(value)?.toUpperCase() || null;
}

function toPositiveFactor(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
}

async function assertProductExists(tenantId, sku, label) {
  const [rows] = await db.query(
    `SELECT sku FROM products WHERE tenant_id = ? AND sku = ? LIMIT 1`,
    [tenantId, sku]
  );
  if (!rows.length) {
    const err = new Error(`${label} 상품을 찾을 수 없습니다: ${sku}`);
    err.status = 400;
    throw err;
  }
}

async function assertNoDuplicateComposition({ tenantId, sourceSku, baseSku, excludeId = null }) {
  const params = [tenantId, sourceSku, baseSku];
  let extra = '';
  if (excludeId) {
    extra = ' AND id <> ?';
    params.push(excludeId);
  }

  const [rows] = await db.query(
    `SELECT id
     FROM sku_compositions
     WHERE tenant_id = ?
       AND source_sku = ?
       AND base_sku = ?
       ${extra}
     LIMIT 1`,
    params
  );

  if (rows.length) {
    const err = new Error(`이미 등록된 구성입니다: ${sourceSku} → ${baseSku}`);
    err.status = 409;
    throw err;
  }
}

router.get('/dashboard', async (req, res) => {
  const tenantId = getCurrentTenantId(req);

  const [purchaseNeededRows] = await db.query(
    `SELECT
       p.sku,
       p.product_name_kr,
       p.product_name_en,
       p.option_name,
       p.stock_quantity,
       p.low_stock_threshold,
       p.cost_price_with_vat,
       p.supply_rate,
       p.discounted_price_with_vat,
       p.cost_price,
       (
         SELECT ROUND(b.unit_cost * 1.1, 0)
         FROM inventory_batches b
         WHERE b.tenant_id = p.tenant_id
           AND b.sku COLLATE utf8mb4_unicode_ci = p.sku COLLATE utf8mb4_unicode_ci
         ORDER BY b.received_at IS NULL, b.received_at DESC, b.id DESC
         LIMIT 1
       ) AS latest_receipt_price_vat_included,
       (
         SELECT b.received_at
         FROM inventory_batches b
         WHERE b.tenant_id = p.tenant_id
           AND b.sku COLLATE utf8mb4_unicode_ci = p.sku COLLATE utf8mb4_unicode_ci
         ORDER BY b.received_at IS NULL, b.received_at DESC, b.id DESC
         LIMIT 1
       ) AS latest_receipt_at,
       p.cost_price,
       COALESCE(pending_receipts.pending_receipt_qty, 0) AS pending_receipt_qty,
       COALESCE(pending_receipts.pending_receipt_count, 0) AS pending_receipt_count,
       CASE
         WHEN p.stock_quantity < 0 THEN ABS(p.stock_quantity)
         ELSE 0
       END AS purchase_needed_qty
     FROM products p
     LEFT JOIN (
       SELECT tenant_id, sku, SUM(quantity) AS pending_receipt_qty, COUNT(*) AS pending_receipt_count
       FROM stock_receipts
       WHERE status = 'PENDING'
       GROUP BY tenant_id, sku
     ) pending_receipts
       ON pending_receipts.tenant_id = p.tenant_id
      AND pending_receipts.sku COLLATE utf8mb4_unicode_ci = p.sku COLLATE utf8mb4_unicode_ci
     WHERE p.tenant_id = ?
       AND p.stock_quantity < 0
     ORDER BY
       purchase_needed_qty DESC,
       p.sku ASC
     LIMIT 500`,
    [tenantId]
  );

  const [summaryRows] = await db.query(
    `SELECT
       COUNT(*) AS total_product_count,
       SUM(CASE WHEN stock_quantity < 0 THEN 1 ELSE 0 END) AS negative_stock_count,
       SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END) AS out_of_stock_count,
       SUM(CASE WHEN stock_quantity > 0 AND stock_quantity <= low_stock_threshold THEN 1 ELSE 0 END) AS low_stock_count
     FROM products
     WHERE tenant_id = ?`,
    [tenantId]
  );

  const [recentReceiptRows] = await db.query(
    `SELECT
       b.id,
       b.receipt_id,
       b.receipt_no,
       b.source_sku,
       b.sku,
       p.product_name_kr,
       p.product_name_en,
       p.option_name,
       b.received_at,
       b.receipt_type,
       b.initial_qty,
       b.remaining_qty,
       b.unit_cost,
       b.source_unit_cost,
       b.conversion_factor,
       b.note,
       b.sheet_row,
       b.created_at
     FROM inventory_batches b
     LEFT JOIN products p
       ON p.tenant_id = b.tenant_id
      AND p.sku COLLATE utf8mb4_unicode_ci = b.sku COLLATE utf8mb4_unicode_ci
     WHERE b.tenant_id = ?
     ORDER BY COALESCE(b.received_at, b.created_at) DESC, b.id DESC
     LIMIT 200`,
    [tenantId]
  );

  return res.json({
    success: true,
    summary: summaryRows[0] || {},
    purchase_needed: purchaseNeededRows,
    recent_receipts: recentReceiptRows,
  });
});

router.get('/stock-receipts', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const status = cleanText(req.query.status);
  const keyword = likeKeyword(req.query.q);
  const params = [tenantId];

  let where = 'WHERE r.tenant_id = ?';
  if (status && ['PENDING', 'COMPLETED', 'CANCELLED'].includes(status)) {
    where += ' AND r.status = ?';
    params.push(status);
  }
  if (keyword) {
    where += ` AND (
      r.receipt_code LIKE ?
      OR r.sku LIKE ?
      OR r.supplier LIKE ?
      OR r.memo LIKE ?
      OR p.product_name_kr LIKE ?
      OR p.product_name_en LIKE ?
      OR p.option_name LIKE ?
    )`;
    params.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword);
  }

  const [rows] = await db.query(
    `SELECT
       r.*,
       p.product_name_kr,
       p.product_name_en,
       p.option_name,
       p.stock_quantity
     FROM stock_receipts r
     LEFT JOIN products p
       ON p.tenant_id = r.tenant_id
      AND p.sku COLLATE utf8mb4_unicode_ci = r.sku COLLATE utf8mb4_unicode_ci
     ${where}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 200`,
    params
  );

  return res.json({ success: true, data: rows });
});

router.post('/stock-receipts', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const sku = normalizeInputSku(req.body.sku);
  const quantity = parsePositiveInt(req.body.quantity);
  const status = cleanText(req.body.status) || 'PENDING';
  const supplier = cleanText(req.body.supplier);
  const memo = cleanText(req.body.memo);
  const expectedDate = cleanText(req.body.expected_date);
  const receiptDate = cleanText(req.body.receipt_date) || todayDateKst();
  const priceVatIncluded = Number(req.body.price_vat_included || 0);
  const { supplyRate, unitPriceVatIncluded, unitCost } = computeCosts({
    priceVatIncluded,
    supplyRate: req.body.supply_rate,
  });

  if (!sku || !quantity || priceVatIncluded <= 0) {
    return res.status(400).json({
      success: false,
      error: 'SKU, 입고수량, 부가세포함 단가는 필수입니다.',
    });
  }
  if (!['PENDING', 'COMPLETED'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: '신규 입고 상태는 PENDING 또는 COMPLETED만 가능합니다.',
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const product = await getProductBySku(conn, tenantId, sku);
    if (!product) {
      const err = new Error(`상품을 찾을 수 없습니다: ${sku}`);
      err.status = 400;
      throw err;
    }

    const receiptCode = makeReceiptCode({ sku, dateText: receiptDate });

    const [insertResult] = await conn.query(
      `INSERT INTO stock_receipts
         (tenant_id, receipt_code, sku, status, receipt_date, expected_date,
          quantity, supplier, price_vat_included, supply_rate,
          unit_price_vat_included, unit_cost, memo)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        receiptCode,
        sku,
        receiptDate,
        expectedDate || null,
        quantity,
        supplier,
        priceVatIncluded,
        supplyRate,
        unitPriceVatIncluded,
        unitCost,
        memo,
      ]
    );

    const receipt = {
      id: insertResult.insertId,
      tenant_id: tenantId,
      receipt_code: receiptCode,
      sku,
      status: 'PENDING',
      receipt_date: receiptDate,
      quantity,
      supplier,
      price_vat_included: priceVatIncluded,
      supply_rate: supplyRate,
      unit_price_vat_included: unitPriceVatIncluded,
      unit_cost: unitCost,
      memo,
    };

    let completion = null;
    if (status === 'COMPLETED') {
      completion = await completeStockReceipt(conn, receipt, { tenantId });
    }

    await conn.commit();

    return res.json({
      success: true,
      id: receipt.id,
      receipt_code: receiptCode,
      status,
      completion,
    });
  } catch (err) {
    await conn.rollback();
    return res.status(err.status || 500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

router.patch('/stock-receipts/:id', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const id = Number(req.params.id);
  const sku = normalizeInputSku(req.body.sku);
  const quantity = parsePositiveInt(req.body.quantity);
  const expectedDate = cleanText(req.body.expected_date);
  const receiptDate = cleanText(req.body.receipt_date);
  const supplier = cleanText(req.body.supplier);
  const memo = cleanText(req.body.memo);
  const priceVatIncluded = Number(req.body.price_vat_included || 0);
  const { supplyRate, unitPriceVatIncluded, unitCost } = computeCosts({
    priceVatIncluded,
    supplyRate: req.body.supply_rate,
  });

  if (!id || !sku || !quantity || priceVatIncluded <= 0) {
    return res.status(400).json({
      success: false,
      error: 'ID, SKU, 입고수량, 부가세포함 단가는 필수입니다.',
    });
  }

  const product = await getProductBySku(db, tenantId, sku);
  if (!product) {
    return res.status(400).json({ success: false, error: `상품을 찾을 수 없습니다: ${sku}` });
  }

  const [result] = await db.query(
    `UPDATE stock_receipts
     SET sku = ?,
         expected_date = ?,
         receipt_date = COALESCE(?, receipt_date),
         quantity = ?,
         supplier = ?,
         price_vat_included = ?,
         supply_rate = ?,
         unit_price_vat_included = ?,
         unit_cost = ?,
         memo = ?
     WHERE tenant_id = ?
       AND id = ?
       AND status = 'PENDING'`,
    [
      sku,
      expectedDate || receiptDate || null,
      receiptDate || null,
      quantity,
      supplier,
      priceVatIncluded,
      supplyRate,
      unitPriceVatIncluded,
      unitCost,
      memo,
      tenantId,
      id,
    ]
  );

  if (result.affectedRows !== 1) {
    return res.status(400).json({
      success: false,
      error: '입고예정 상태의 입고건만 수정할 수 있습니다.',
    });
  }

  return res.json({ success: true });
});

router.post('/stock-receipts/:id/complete', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({ success: false, error: 'ID가 필요합니다.' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT *
       FROM stock_receipts
       WHERE tenant_id = ?
         AND id = ?
       FOR UPDATE`,
      [tenantId, id]
    );
    const receipt = rows[0];
    if (!receipt) {
      const err = new Error('입고건을 찾을 수 없습니다.');
      err.status = 404;
      throw err;
    }

    const completion = await completeStockReceipt(conn, receipt, { tenantId });
    await conn.commit();

    return res.json({ success: true, completion });
  } catch (err) {
    await conn.rollback();
    return res.status(err.status || 500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

router.post('/stock-receipts/:id/cancel', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({ success: false, error: 'ID가 필요합니다.' });
  }

  const [result] = await db.query(
    `UPDATE stock_receipts
     SET status = 'CANCELLED',
         cancelled_at = NOW(),
         memo = COALESCE(NULLIF(?, ''), memo)
     WHERE tenant_id = ?
       AND id = ?
       AND status = 'PENDING'`,
    [cleanText(req.body.memo) || '', tenantId, id]
  );

  if (result.affectedRows !== 1) {
    return res.status(400).json({
      success: false,
      error: '입고예정 상태의 입고건만 취소할 수 있습니다.',
    });
  }

  return res.json({ success: true });
});


router.get('/product-search', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const keyword = likeKeyword(req.query.q);

  if (!keyword) {
    return res.json({ success: true, data: [] });
  }

  const rawQuery = String(req.query.q || '').trim();

  const [rows] = await db.query(
    `SELECT
       sku,
       product_name_kr,
       product_name_en,
       option_name,
       stock_quantity,
       cost_price_with_vat,
       discounted_price_with_vat,
       supply_rate,
       (
         SELECT ROUND(b.unit_cost * 1.1, 0)
         FROM inventory_batches b
         WHERE b.tenant_id = products.tenant_id
           AND b.sku COLLATE utf8mb4_unicode_ci = products.sku COLLATE utf8mb4_unicode_ci
         ORDER BY b.received_at IS NULL, b.received_at DESC, b.id DESC
         LIMIT 1
       ) AS latest_receipt_price_vat_included,
       (
         SELECT b.received_at
         FROM inventory_batches b
         WHERE b.tenant_id = products.tenant_id
           AND b.sku COLLATE utf8mb4_unicode_ci = products.sku COLLATE utf8mb4_unicode_ci
         ORDER BY b.received_at IS NULL, b.received_at DESC, b.id DESC
         LIMIT 1
       ) AS latest_receipt_at
     FROM products
     WHERE tenant_id = ?
       AND (
         sku LIKE ?
         OR product_name_kr LIKE ?
         OR product_name_en LIKE ?
         OR option_name LIKE ?
       )
     ORDER BY
       CASE
         WHEN sku = ? THEN 0
         WHEN sku LIKE ? THEN 1
         ELSE 2
       END,
       sku ASC
     LIMIT 30`,
    [tenantId, keyword, keyword, keyword, keyword, rawQuery, keyword]
  );

  return res.json({ success: true, data: rows });
});

router.get('/sku-compositions', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const keyword = likeKeyword(req.query.q);
  const params = [tenantId];

  let where = 'WHERE c.tenant_id = ?';
  if (keyword) {
    where += ` AND (
      c.source_sku LIKE ?
      OR c.base_sku LIKE ?
      OR c.composition_type LIKE ?
      OR c.note LIKE ?
      OR source_product.product_name_kr LIKE ?
      OR source_product.product_name_en LIKE ?
      OR source_product.option_name LIKE ?
      OR base_product.product_name_kr LIKE ?
      OR base_product.product_name_en LIKE ?
      OR base_product.option_name LIKE ?
    )`;
    params.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword);
  }

  const [rows] = await db.query(
    `SELECT
       c.id,
       c.source_sku,
       c.base_sku,
       c.factor,
       c.composition_type,
       c.note,
       c.sheet_row,
       c.updated_at,
       source_product.product_name_kr AS source_product_name_kr,
       source_product.product_name_en AS source_product_name_en,
       source_product.option_name AS source_option_name,
       base_product.product_name_kr AS base_product_name_kr,
       base_product.product_name_en AS base_product_name_en,
       base_product.option_name AS base_option_name,
       base_product.stock_quantity AS base_stock_quantity
     FROM sku_compositions c
     LEFT JOIN products source_product
       ON source_product.tenant_id = c.tenant_id
      AND source_product.sku COLLATE utf8mb4_unicode_ci = c.source_sku COLLATE utf8mb4_unicode_ci
     LEFT JOIN products base_product
       ON base_product.tenant_id = c.tenant_id
      AND base_product.sku COLLATE utf8mb4_unicode_ci = c.base_sku COLLATE utf8mb4_unicode_ci
     ${where}
     ORDER BY c.source_sku ASC, c.id ASC
     LIMIT 500`,
    params
  );

  const [summaryRows] = await db.query(
    `SELECT
       COUNT(*) AS total_count,
       SUM(CASE WHEN composition_type = '공통' THEN 1 ELSE 0 END) AS common_count,
       SUM(CASE WHEN composition_type = '판매' THEN 1 ELSE 0 END) AS sale_count,
       SUM(CASE WHEN composition_type = '세트' THEN 1 ELSE 0 END) AS set_count
     FROM sku_compositions
     WHERE tenant_id = ?`,
    [tenantId]
  );

  return res.json({
    success: true,
    data: rows,
    summary: summaryRows[0] || {},
  });
});

async function completeStockReceipt(conn, receipt, { tenantId }) {
  if (!receipt) throw new Error('receipt is required');
  if (receipt.status === 'COMPLETED') {
    return { alreadyCompleted: true, receipt };
  }
  if (receipt.status === 'CANCELLED') {
    const err = new Error('취소된 입고는 완료 처리할 수 없습니다.');
    err.status = 400;
    throw err;
  }

  const product = await getProductBySku(conn, tenantId, receipt.sku);
  if (!product) {
    const err = new Error(`상품을 찾을 수 없습니다: ${receipt.sku}`);
    err.status = 400;
    throw err;
  }

  const nowText = mysqlDateTime(new Date());
  const receiptDate = receipt.receipt_date || todayDateKst();
  const memo = receipt.memo || '';
  const stockInNote = memo || `Dashboard stock receipt ${receipt.receipt_code}`;

  const [movementResult] = await conn.query(
    `INSERT INTO inventory_movements
       (tenant_id, sku, movement_type, qty_delta, note)
     VALUES (?, ?, 'STOCK_IN', ?, ?)`,
    [tenantId, receipt.sku, receipt.quantity, stockInNote]
  );
  const movementId = movementResult.insertId;

  const [batchResult] = await conn.query(
    `INSERT INTO inventory_batches
       (tenant_id, receipt_id, receipt_no, source_sku, sku, received_at,
        receipt_type, initial_qty, remaining_qty, unit_cost, source_unit_cost,
        conversion_factor, note, sheet_row)
     VALUES (?, ?, NULL, ?, ?, ?, 'DASHBOARD', ?, ?, ?, ?, 1.0000, ?, NULL)`,
    [
      tenantId,
      receipt.receipt_code,
      receipt.sku,
      receipt.sku,
      `${receiptDate} 00:00:00`,
      receipt.quantity,
      receipt.quantity,
      receipt.unit_cost,
      receipt.unit_price_vat_included,
      stockInNote,
    ]
  );
  const batchId = batchResult.insertId;

  await conn.query(
    `UPDATE products
     SET stock_quantity = stock_quantity + ?
     WHERE tenant_id = ?
       AND sku = ?`,
    [receipt.quantity, tenantId, receipt.sku]
  );

  const shortageAllocation = await allocateOpenShortagesForBatch(conn, {
    tenantId,
    batchId,
    sku: receipt.sku,
    receiptId: receipt.receipt_code,
  });

  await conn.query(
    `UPDATE stock_receipts
     SET status = 'COMPLETED',
         completed_at = ?,
         receipt_date = ?,
         movement_id = ?,
         batch_id = ?,
         allocated_shortage_qty = ?
     WHERE tenant_id = ?
       AND id = ?`,
    [
      nowText,
      receiptDate,
      movementId,
      batchId,
      Number(shortageAllocation?.allocatedQty || 0),
      tenantId,
      receipt.id,
    ]
  );

  return {
    movementId,
    batchId,
    allocatedShortageQty: Number(shortageAllocation?.allocatedQty || 0),
  };
}


router.post('/sku-compositions', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const sourceSku = normalizeInputSku(req.body.source_sku);
  const baseSku = normalizeInputSku(req.body.base_sku);
  const factor = toPositiveFactor(req.body.factor);
  const compositionType = cleanText(req.body.composition_type) || '공통';
  const note = cleanText(req.body.note);

  if (!sourceSku || !baseSku || !factor) {
    return res.status(400).json({
      success: false,
      error: 'SKU, 기준재고SKU, 기준수량은 필수입니다. 기준수량은 1 이상이어야 합니다.',
    });
  }

  await assertProductExists(tenantId, sourceSku, '판매 SKU');
  await assertProductExists(tenantId, baseSku, '기준재고 SKU');
  await assertNoDuplicateComposition({ tenantId, sourceSku, baseSku });

  const [result] = await db.query(
    `INSERT INTO sku_compositions
       (tenant_id, source_sku, base_sku, factor, composition_type, note, sheet_row)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [tenantId, sourceSku, baseSku, factor, compositionType, note]
  );

  return res.json({ success: true, id: result.insertId });
});

router.patch('/sku-compositions/:id', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const id = Number(req.params.id);
  const sourceSku = normalizeInputSku(req.body.source_sku);
  const baseSku = normalizeInputSku(req.body.base_sku);
  const factor = toPositiveFactor(req.body.factor);
  const compositionType = cleanText(req.body.composition_type) || '공통';
  const note = cleanText(req.body.note);

  if (!id || !sourceSku || !baseSku || !factor) {
    return res.status(400).json({
      success: false,
      error: 'ID, SKU, 기준재고SKU, 기준수량은 필수입니다. 기준수량은 1 이상이어야 합니다.',
    });
  }

  await assertProductExists(tenantId, sourceSku, '판매 SKU');
  await assertProductExists(tenantId, baseSku, '기준재고 SKU');
  await assertNoDuplicateComposition({ tenantId, sourceSku, baseSku, excludeId: id });

  const [result] = await db.query(
    `UPDATE sku_compositions
     SET source_sku = ?,
         base_sku = ?,
         factor = ?,
         composition_type = ?,
         note = ?,
         updated_at = NOW()
     WHERE tenant_id = ?
       AND id = ?`,
    [sourceSku, baseSku, factor, compositionType, note, tenantId, id]
  );

  if (result.affectedRows !== 1) {
    return res.status(404).json({ success: false, error: '상품구성을 찾을 수 없습니다.' });
  }

  return res.json({ success: true });
});

router.delete('/sku-compositions/:id', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({ success: false, error: 'ID가 필요합니다.' });
  }

  const [result] = await db.query(
    `DELETE FROM sku_compositions
     WHERE tenant_id = ?
       AND id = ?`,
    [tenantId, id]
  );

  if (result.affectedRows !== 1) {
    return res.status(404).json({ success: false, error: '상품구성을 찾을 수 없습니다.' });
  }

  return res.json({ success: true });
});


module.exports = router;
