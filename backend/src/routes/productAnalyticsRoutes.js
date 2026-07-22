const express = require('express');
const db = require('../config/database');
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const { getCurrentTenantId } = require('../config/tenant');

const router = express.Router();
router.use(requireAuth);
router.use(requireApprovedTenant);

function dateRange(req) {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.end_date || '')) ? String(req.query.end_date) : null;
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.start_date || '')) ? String(req.query.start_date) : null;
  return { start, end };
}

function filters(req, alias = 'o') {
  const { start, end } = dateRange(req);
  const region = String(req.query.region || '').trim().toUpperCase();
  const shopId = String(req.query.shop_id || '').trim();
  const clauses = [`${alias}.tenant_id = ?`];
  const params = [getCurrentTenantId(req)];
  if (start) { clauses.push(`${alias}.order_created_at >= ?`); params.push(start); }
  if (end) { clauses.push(`${alias}.order_created_at < DATE_ADD(?, INTERVAL 1 DAY)`); params.push(end); }
  if (region) { clauses.push(`${alias}.region = ?`); params.push(region); }
  if (shopId) { clauses.push(`${alias}.shop_id = ?`); params.push(shopId); }
  return { sql: clauses.join(' AND '), params };
}

function analyticsCte(whereSql) {
  return `
    WITH movement_fifo AS (
      SELECT m.tenant_id, m.order_sn, m.shop_id, m.item_id, m.model_id,
             ABS(m.qty_delta) required_qty, COALESCE(SUM(a.qty), 0) allocated_qty,
             COALESCE(SUM(a.total_cost), 0) fifo_cost
      FROM inventory_movements m
      LEFT JOIN inventory_allocations a ON a.tenant_id = m.tenant_id AND a.movement_id = m.id
      WHERE m.movement_type = 'SALE'
      GROUP BY m.tenant_id, m.id, m.order_sn, m.shop_id, m.item_id, m.model_id, m.qty_delta
    ), item_fifo AS (
      SELECT tenant_id, order_sn, shop_id, item_id, model_id,
             SUM(required_qty) required_qty, SUM(allocated_qty) allocated_qty, SUM(fifo_cost) fifo_cost
      FROM movement_fifo GROUP BY tenant_id, order_sn, shop_id, item_id, model_id
    ), lines AS (
      SELECT o.tenant_id, o.order_sn, o.shop_id, o.region, o.order_status, o.order_created_at,
             o.currency, er.rate_to_krw, o.net_profit order_net_profit,
             COALESCE(o.order_chargeable_weight_gram, 0) order_weight_gram,
             COALESCE(o.total_cost_price, 0) original_order_cost,
             COALESCE(NULLIF(oi.model_sku, ''), NULLIF(oi.item_sku, '')) sku,
             oi.item_id, oi.model_id, oi.item_name, oi.model_name,
             COALESCE(oi.image_info_image_url, oi.item_image_url) image_url,
             COALESCE(oi.model_quantity_purchased, 1) qty,
             COALESCE(NULLIF(oi.model_discounted_price, 0), oi.model_original_price, 0)
               * COALESCE(oi.model_quantity_purchased, 1) line_sales_local,
             CASE WHEN f.required_qty IS NOT NULL AND f.allocated_qty >= f.required_qty
                  THEN f.fifo_cost
                  ELSE COALESCE(oi.cost_price_at_order, 0) * COALESCE(oi.model_quantity_purchased, 1)
             END item_cost
      FROM orders o
      JOIN order_items oi ON oi.tenant_id = o.tenant_id AND oi.order_sn = o.order_sn AND oi.shop_id = o.shop_id
      LEFT JOIN exchange_rates er ON er.currency COLLATE utf8mb4_general_ci = o.currency COLLATE utf8mb4_general_ci
      LEFT JOIN item_fifo f ON f.tenant_id = oi.tenant_id AND f.order_sn = oi.order_sn AND f.shop_id = oi.shop_id
       AND f.item_id <=> oi.item_id AND f.model_id <=> oi.model_id
      WHERE ${whereSql}
    ), weighted AS (
      SELECT lines.*,
             SUM(line_sales_local) OVER (PARTITION BY tenant_id, shop_id, order_sn) order_line_sales,
             COUNT(*) OVER (PARTITION BY tenant_id, shop_id, order_sn) order_line_count
      FROM lines WHERE sku IS NOT NULL
    ), allocated AS (
      SELECT weighted.*,
             CASE WHEN order_line_sales > 0 THEN line_sales_local / order_line_sales ELSE 1 / order_line_count END ratio,
             CASE WHEN order_status NOT IN ('UNPAID','PENDING','CANCELLED') THEN line_sales_local * rate_to_krw ELSE 0 END sales_krw,
             CASE WHEN order_status NOT IN ('UNPAID','PENDING','CANCELLED') THEN qty ELSE 0 END sold_qty,
             CASE WHEN order_status NOT IN ('UNPAID','PENDING','CANCELLED') THEN 1 ELSE 0 END valid_order,
             CASE WHEN order_status = 'CANCELLED' THEN 1 ELSE 0 END cancelled_order,
             CASE WHEN order_status NOT IN ('UNPAID','PENDING','CANCELLED') AND order_net_profit IS NOT NULL AND order_weight_gram > 0
                  THEN (order_net_profit + original_order_cost)
                    * (CASE WHEN order_line_sales > 0 THEN line_sales_local / order_line_sales ELSE 1 / order_line_count END)
                  ELSE NULL END allocated_settlement_krw,
             CASE WHEN order_status NOT IN ('UNPAID','PENDING','CANCELLED') AND order_net_profit IS NOT NULL AND order_weight_gram > 0
                  THEN (order_net_profit + original_order_cost)
                    * (CASE WHEN order_line_sales > 0 THEN line_sales_local / order_line_sales ELSE 1 / order_line_count END) - item_cost
                  ELSE NULL END allocated_profit_krw
      FROM weighted
    )`;
}

router.get('/overview', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const scoped = filters(req);
  const search = String(req.query.search || '').trim();
  const cte = analyticsCte(scoped.sql);
  try {
    const [performance] = await db.query(`${cte}
      SELECT sku,
        MAX(item_name) item_name, MAX(model_name) option_name, MAX(image_url) image_url,
        GROUP_CONCAT(DISTINCT region ORDER BY region SEPARATOR ',') regions,
        SUM(sold_qty) sold_qty, COUNT(DISTINCT CASE WHEN valid_order = 1 THEN CONCAT(shop_id, ':', order_sn) END) order_count,
        SUM(sales_krw) sales_krw, SUM(allocated_settlement_krw) settlement_krw,
        SUM(CASE WHEN allocated_profit_krw IS NOT NULL THEN item_cost ELSE 0 END) cost_krw,
        SUM(allocated_profit_krw) net_profit_krw,
        COUNT(DISTINCT CASE WHEN cancelled_order = 1 THEN CONCAT(shop_id, ':', order_sn) END) cancelled_orders,
        COUNT(DISTINCT CONCAT(shop_id, ':', order_sn)) all_orders,
        COUNT(DISTINCT CASE WHEN valid_order = 1 AND (order_net_profit IS NULL OR order_weight_gram <= 0) THEN CONCAT(shop_id, ':', order_sn) END) pending_settlement_orders,
        MAX(order_created_at) last_sold_at
      FROM allocated GROUP BY sku`, scoped.params);

    const [products] = await db.query(
      `SELECT p.sku, p.product_name_kr, p.product_name_en, p.option_name, p.stock_quantity,
              COALESCE(p.cost_price_with_vat, p.discounted_price_with_vat, p.cost_price * 1.1) current_cost,
              (SELECT COALESCE(oi.image_info_image_url, oi.item_image_url) FROM order_items oi
               WHERE oi.tenant_id = p.tenant_id AND COALESCE(NULLIF(oi.model_sku,''), NULLIF(oi.item_sku,'')) = p.sku
               ORDER BY oi.id DESC LIMIT 1) image_url
       FROM products p WHERE p.tenant_id = ? ORDER BY p.sku`, [tenantId]);

    const perfMap = new Map(performance.map(row => [String(row.sku), row]));
    let rows = products.map(product => ({ ...product, ...(perfMap.get(String(product.sku)) || {}) }));
    const productSkus = new Set(products.map(row => String(row.sku)));
    rows.push(...performance.filter(row => !productSkus.has(String(row.sku))).map(row => ({ ...row, stock_quantity: 0, current_cost: null, cost_missing: true })));
    rows = rows.map(row => {
      const sales = Number(row.sales_krw || 0); const profit = row.net_profit_krw == null ? null : Number(row.net_profit_krw);
      return { ...row, sold_qty: Number(row.sold_qty || 0), order_count: Number(row.order_count || 0), sales_krw: sales,
        settlement_krw: row.settlement_krw == null ? null : Number(row.settlement_krw), cost_krw: Number(row.cost_krw || 0),
        net_profit_krw: profit, profit_rate: profit == null || !sales ? null : profit / sales * 100,
        cancellation_rate: Number(row.all_orders || 0) ? Number(row.cancelled_orders || 0) / Number(row.all_orders) * 100 : 0,
        stock_quantity: Number(row.stock_quantity || 0), current_cost: row.current_cost == null ? null : Number(row.current_cost),
        cost_missing: row.current_cost == null, pending_settlement_orders: Number(row.pending_settlement_orders || 0) };
    });
    if (search) { const q = search.toLocaleLowerCase(); rows = rows.filter(row => [row.sku, row.product_name_kr, row.product_name_en, row.item_name, row.option_name].some(value => String(value || '').toLocaleLowerCase().includes(q))); }
    const sort = String(req.query.sort || 'net_profit_krw'); const direction = req.query.direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => ((Number(a[sort] || 0) - Number(b[sort] || 0)) * direction) || String(a.sku).localeCompare(String(b.sku)));
    const summary = rows.reduce((acc, row) => { acc.sku_count += 1; acc.sold_qty += row.sold_qty; acc.order_count += row.order_count; acc.sales_krw += row.sales_krw; acc.settlement_krw += Number(row.settlement_krw || 0); acc.cost_krw += row.cost_krw; acc.net_profit_krw += Number(row.net_profit_krw || 0); if (row.cost_missing) acc.missing_cost_count += 1; if (row.net_profit_krw < 0) acc.loss_sku_count += 1; acc.pending_settlement_orders += row.pending_settlement_orders; return acc; }, { sku_count: 0, sold_qty: 0, order_count: 0, sales_krw: 0, settlement_krw: 0, cost_krw: 0, net_profit_krw: 0, missing_cost_count: 0, loss_sku_count: 0, pending_settlement_orders: 0 });
    summary.profit_rate = summary.sales_krw ? summary.net_profit_krw / summary.sales_krw * 100 : null;
    const page = Math.max(1, Number(req.query.page || 1)); const pageSize = Math.min(200, Math.max(10, Number(req.query.page_size || 50)));
    res.json({ success: true, summary, rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, page_size: pageSize });
  } catch (error) { console.error('[ProductAnalytics] overview:', error); res.status(500).json({ success: false, error: error.message }); }
});

router.get('/sku/:sku', async (req, res) => {
  const sku = decodeURIComponent(req.params.sku); const scoped = filters(req); const cte = analyticsCte(scoped.sql);
  try {
    const [countries] = await db.query(`${cte}
      SELECT region, shop_id, MAX(item_id) item_id, MAX(model_id) option_id, MAX(item_name) item_name,
             MAX(model_name) option_name, SUM(sold_qty) sold_qty, SUM(sales_krw) sales_krw,
             SUM(allocated_profit_krw) net_profit_krw, MAX(order_created_at) last_sold_at
      FROM allocated WHERE sku = ? GROUP BY region, shop_id ORDER BY region, shop_id`, [...scoped.params, sku]);
    const [orders] = await db.query(`${cte}
      SELECT order_sn, shop_id, region, order_created_at, order_status, item_id, model_id option_id,
             item_name, model_name option_name, qty, sales_krw,
             allocated_settlement_krw settlement_krw, item_cost cost_krw, allocated_profit_krw net_profit_krw
      FROM allocated WHERE sku = ? ORDER BY order_created_at DESC LIMIT 100`, [...scoped.params, sku]);
    const [batches] = await db.query(
      `SELECT id, remaining_qty, unit_cost, received_at FROM inventory_batches
       WHERE tenant_id = ? AND sku = ? ORDER BY received_at DESC, id DESC LIMIT 100`, [getCurrentTenantId(req), sku]);
    res.json({ success: true, countries, orders, batches });
  } catch (error) { console.error('[ProductAnalytics] detail:', error); res.status(500).json({ success: false, error: error.message }); }
});

module.exports = router;
