/**
 * 주문 DB 저장/조회 유틸
 * - orders UPSERT
 * - order_items INSERT
 * - sync_logs 기록
 * - 미완료 주문 조회
 */

const db = require('../config/database');

/**
 * 주문 1건 UPSERT (신규: INSERT, 기존: 무시)
 */
async function insertOrder(conn, orderRow) {
  const cols = Object.keys(orderRow);
  const vals = Object.values(orderRow);
  const placeholders = cols.map(() => '?').join(', ');
  const colNames = cols.join(', ');

  await conn.query(
    `INSERT IGNORE INTO orders (${colNames}, synced_at)
     VALUES (${placeholders}, NOW())`,
    vals
  );
}

/**
 * 주문 배치 UPSERT
 * @param {object[]} orderRows
 * @returns {{ inserted: number }}
 */
async function batchInsertOrders(orderRows) {
  if (!orderRows.length) return { inserted: 0 };

  const conn = await db.getConnection();
  let inserted = 0;
  try {
    await conn.beginTransaction();
    for (const row of orderRows) {
      const [result] = await conn.query(
        `INSERT IGNORE INTO orders (
          shop_id, region, order_sn, order_status, is_final_status,
          merchandise_subtotal, total_amount, currency,
          original_price, seller_discount, voucher_from_seller, voucher_from_shopee,
          coins_offset, buyer_total_amount,
          shipping_carrier, tracking_number, shipping_fee, shipping_fee_discount,
          actual_shipping_fee, estimated_shipping_fee, order_chargeable_weight_gram,
          commission_fee, service_fee, transaction_fee, escrow_amount,
          create_time, order_created_at, update_time, synced_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, NOW()
        )`,
        [
          row.shop_id, row.region, row.order_sn, row.order_status, row.is_final_status,
          row.merchandise_subtotal, row.total_amount, row.currency,
          row.original_price, row.seller_discount, row.voucher_from_seller, row.voucher_from_shopee,
          row.coins_offset, row.buyer_total_amount,
          row.shipping_carrier, row.tracking_number, row.shipping_fee, row.shipping_fee_discount,
          row.actual_shipping_fee, row.estimated_shipping_fee, row.order_chargeable_weight_gram,
          row.commission_fee, row.service_fee, row.transaction_fee, row.escrow_amount,
          row.create_time, row.order_created_at, row.update_time,
        ]
      );
      inserted += result.affectedRows;
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { inserted };
}

/**
 * order_items 배치 INSERT (중복 무시)
 */
async function batchInsertOrderItems(itemRows) {
  if (!itemRows.length) return;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of itemRows) {
      await conn.query(
        `INSERT IGNORE INTO order_items (
          order_sn, shop_id, item_id, item_name, item_sku,
          model_id, model_name, model_sku,
          model_quantity_purchased, model_original_price, model_discounted_price,
          image_info_image_url, item_image_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.order_sn, item.shop_id, item.item_id, item.item_name, item.item_sku,
          item.model_id, item.model_name, item.model_sku,
          item.model_quantity_purchased, item.model_original_price, item.model_discounted_price,
          item.image_info_image_url, item.item_image_url,
        ]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 주문 업데이트 (변경 필드만)
 * @param {string} orderSn
 * @param {number} shopId
 * @param {object} diff - { field: newValue, ... }
 */
async function updateOrder(orderSn, shopId, diff) {
  if (!Object.keys(diff).length) return false;

  const sets = Object.keys(diff).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(diff), orderSn, shopId];

  await db.query(
    `UPDATE orders SET ${sets}, synced_at = NOW() WHERE order_sn = ? AND shop_id = ?`,
    vals
  );
  return true;
}

/**
 * DB에 이미 있는 order_sn 필터링
 * @param {number} shopId
 * @param {string[]} orderSns
 * @returns {string[]} DB에 없는 order_sn만
 */
async function filterNewOrderSns(shopId, orderSns) {
  if (!orderSns.length) return [];

  const placeholders = orderSns.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT order_sn FROM orders WHERE shop_id = ? AND order_sn IN (${placeholders})`,
    [shopId, ...orderSns]
  );
  const existing = new Set(rows.map(r => r.order_sn));
  return orderSns.filter(sn => !existing.has(sn));
}

/**
 * 특정 샵의 가장 최근 create_time 조회
 * @returns {number|null} unix timestamp
 */
async function getLatestCreateTime(shopId) {
  const [rows] = await db.query(
    'SELECT MAX(create_time) as latest FROM orders WHERE shop_id = ?',
    [shopId]
  );
  return rows[0]?.latest || null;
}

/**
 * is_final_status = 0 인 주문 조회 (샵별)
 * @param {number} shopId
 * @returns {{ order_sn: string, order_status: string, ... }[]}
 */
async function getNonFinalOrders(shopId) {
  const [rows] = await db.query(
    `SELECT order_sn, order_status, actual_shipping_fee, order_chargeable_weight_gram,
            commission_fee, service_fee, transaction_fee, escrow_amount, tracking_number,
            is_final_status, update_time
     FROM orders WHERE shop_id = ? AND is_final_status = 0`,
    [shopId]
  );
  return rows;
}

/**
 * sync_logs 기록
 */
async function logSync(shopId, syncType, windowStart, windowEnd, fetched, updated, status, errorMsg) {
  await db.query(
    `INSERT INTO sync_logs
     (shop_id, sync_type, sync_window_start, sync_window_end, orders_fetched, orders_updated, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [shopId, syncType, windowStart, windowEnd, fetched, updated, status, errorMsg || null]
  );
}

/**
 * 백필 재개용: 마지막 성공 윈도우 종료 시각 조회
 * @param {number} shopId
 * @returns {Date|null}
 */
async function getLastSuccessfulBackfillEnd(shopId) {
  const [rows] = await db.query(
    `SELECT MAX(sync_window_end) as last_end
     FROM sync_logs
     WHERE shop_id = ? AND sync_type = 'backfill' AND status = 'success'`,
    [shopId]
  );
  return rows[0]?.last_end || null;
}

module.exports = {
  insertOrder,
  batchInsertOrders,
  batchInsertOrderItems,
  updateOrder,
  filterNewOrderSns,
  getLatestCreateTime,
  getNonFinalOrders,
  logSync,
  getLastSuccessfulBackfillEnd,
};
