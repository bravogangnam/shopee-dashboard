const express = require('express');
const router = express.Router();

const db = require('../config/database');
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const { getCurrentTenantId } = require('../config/tenant');

router.use(requireAuth);
router.use(requireApprovedTenant);

function likeKeyword(keyword) {
  const text = String(keyword || '').trim();
  return text ? `%${text}%` : null;
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
       CASE
         WHEN p.stock_quantity < 0 THEN ABS(p.stock_quantity)
         WHEN p.stock_quantity = 0 THEN GREATEST(p.low_stock_threshold, 1)
         WHEN p.stock_quantity > 0 AND p.stock_quantity <= p.low_stock_threshold THEN GREATEST(p.low_stock_threshold - p.stock_quantity, 1)
         ELSE 0
       END AS purchase_needed_qty
     FROM products p
     WHERE p.tenant_id = ?
       AND (
         p.stock_quantity < 0
         OR p.stock_quantity = 0
         OR (p.stock_quantity > 0 AND p.stock_quantity <= p.low_stock_threshold)
       )
     ORDER BY
       CASE
         WHEN p.stock_quantity < 0 THEN 0
         WHEN p.stock_quantity = 0 THEN 1
         ELSE 2
       END,
       purchase_needed_qty DESC,
       p.sku ASC
     LIMIT 50`,
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
     LIMIT 30`,
    [tenantId]
  );

  return res.json({
    success: true,
    summary: summaryRows[0] || {},
    purchase_needed: purchaseNeededRows,
    recent_receipts: recentReceiptRows,
  });
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

module.exports = router;
