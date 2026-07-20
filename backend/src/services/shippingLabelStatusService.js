'use strict';

const db = require('../config/database');

let ensured = false;

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function addColumnIfMissing(tableName, columnName, definition) {
  if (await columnExists(tableName, columnName)) return;
  try {
    await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (err) {
    if (err?.code === 'ER_DUP_FIELDNAME' || /Duplicate column name/i.test(err?.message || '')) {
      return;
    }
    throw err;
  }
}

async function ensureShippingLabelStatusColumns() {
  if (ensured) return;

  await addColumnIfMissing(
    'orders',
    'shipping_label_status',
    "VARCHAR(32) NULL DEFAULT NULL COMMENT 'internal label workflow status: ready_to_print, printed, failed'"
  );
  await addColumnIfMissing(
    'orders',
    'shipping_label_prepared_at',
    'DATETIME NULL DEFAULT NULL'
  );
  await addColumnIfMissing(
    'orders',
    'shipping_label_printed_at',
    'DATETIME NULL DEFAULT NULL'
  );
  await addColumnIfMissing(
    'orders',
    'shipping_label_error',
    'TEXT NULL'
  );

  ensured = true;
}

async function markLabelReady({ tenantId, shopId, orderSn }) {
  await ensureShippingLabelStatusColumns();
  await db.query(
    `UPDATE orders
     SET shipping_label_status = 'ready_to_print',
         shipping_label_prepared_at = COALESCE(shipping_label_prepared_at, NOW()),
         shipping_label_error = NULL
     WHERE tenant_id = ?
       AND shop_id = ?
       AND order_sn = ?
       AND COALESCE(shipping_label_status, '') <> 'printed'`,
    [tenantId, shopId, orderSn]
  );
}

async function markLabelPrinted({ tenantId, shopId, orderSn }) {
  await ensureShippingLabelStatusColumns();
  await db.query(
    `UPDATE orders
     SET shipping_label_status = 'printed',
         shipping_label_prepared_at = COALESCE(shipping_label_prepared_at, NOW()),
         shipping_label_printed_at = COALESCE(shipping_label_printed_at, NOW()),
         shipping_label_error = NULL
     WHERE tenant_id = ?
       AND shop_id = ?
       AND order_sn = ?`,
    [tenantId, shopId, orderSn]
  );
}

async function markLabelFailed({ tenantId, shopId, orderSn, error }) {
  await ensureShippingLabelStatusColumns();
  await db.query(
    `UPDATE orders
     SET shipping_label_status = 'failed',
         shipping_label_error = ?
     WHERE tenant_id = ?
       AND shop_id = ?
       AND order_sn = ?
       AND COALESCE(shipping_label_status, '') <> 'printed'`,
    [String(error || '').slice(0, 2000), tenantId, shopId, orderSn]
  );
}

module.exports = {
  ensureShippingLabelStatusColumns,
  markLabelReady,
  markLabelPrinted,
  markLabelFailed,
};
