const db = require('../config/database');
const { notifyNewOrders, resolveUnitPrice } = require('../utils/telegramNotifier');

let tableReady = null;

async function ensureOrderAlertDeliveriesTable() {
  if (tableReady) return tableReady;
  tableReady = db.query(`
    CREATE TABLE IF NOT EXISTS order_alert_deliveries (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      shop_id BIGINT NOT NULL,
      order_sn VARCHAR(50) NOT NULL,
      alert_type VARCHAR(30) NOT NULL,
      status ENUM('processing','sent','failed') NOT NULL DEFAULT 'processing',
      attempts INT NOT NULL DEFAULT 1,
      error_message VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      sent_at DATETIME NULL,
      UNIQUE KEY uq_order_alert_delivery (tenant_id, shop_id, order_sn, alert_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(error => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

async function loadNewOrderAlert(tenantId, shopId, orderSn) {
  const [rows] = await db.query(
    `SELECT o.region, o.currency, COALESCE(o.display_status, o.order_status) AS display_status,
            oi.item_name, oi.model_name, oi.model_quantity_purchased,
            oi.model_original_price, oi.model_discounted_price,
            p.product_name_kr
       FROM orders o
       JOIN order_items oi
         ON oi.tenant_id = o.tenant_id
        AND oi.shop_id = o.shop_id
        AND oi.order_sn = o.order_sn
       LEFT JOIN products p
         ON p.tenant_id = oi.tenant_id
        AND p.sku COLLATE utf8mb4_general_ci =
            COALESCE(NULLIF(oi.model_sku, ''), NULLIF(oi.item_sku, '')) COLLATE utf8mb4_general_ci
      WHERE o.tenant_id = ? AND o.shop_id = ? AND o.order_sn = ?
      ORDER BY oi.id ASC`,
    [tenantId, shopId, orderSn]
  );
  if (!rows.length) return null;
  return {
    region: rows[0].region || '-',
    displayStatus: rows[0].display_status || '-',
    items: rows.map(row => ({
      region: row.region || '-',
      orderSn,
      productName: row.product_name_kr || row.item_name || '-',
      optionName: row.product_name_kr ? '' : (row.model_name || ''),
      qty: Number(row.model_quantity_purchased || 1),
      unitPrice: resolveUnitPrice(row.model_discounted_price, row.model_original_price),
      currency: row.currency || '',
    })),
  };
}

async function claimDelivery(tenantId, shopId, orderSn) {
  const [insert] = await db.query(
    `INSERT IGNORE INTO order_alert_deliveries
       (tenant_id, shop_id, order_sn, alert_type)
     VALUES (?, ?, ?, 'NEW_ORDER')`,
    [tenantId, shopId, orderSn]
  );
  if (insert.affectedRows === 1) return true;
  const [retry] = await db.query(
    `UPDATE order_alert_deliveries
        SET status='processing', attempts=attempts+1, error_message=NULL
      WHERE tenant_id=? AND shop_id=? AND order_sn=? AND alert_type='NEW_ORDER'
        AND (status='failed' OR (status='processing' AND updated_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)))`,
    [tenantId, shopId, orderSn]
  );
  return retry.affectedRows === 1;
}

async function notifyNewOrderOnce({ tenantId, shopId, orderSn }) {
  try {
    await ensureOrderAlertDeliveriesTable();
    const alert = await loadNewOrderAlert(tenantId, shopId, orderSn);
    if (!alert?.items?.length) return { skipped: true, reason: 'order_items_unavailable' };
    if (alert.displayStatus !== 'READY_TO_SHIP') {
      return { skipped: true, reason: `display_status:${alert.displayStatus || '-'}` };
    }
    if (!await claimDelivery(tenantId, shopId, orderSn)) {
      return { skipped: true, reason: 'already_delivered_or_processing' };
    }
    const result = await notifyNewOrders(1, { [alert.region]: 1 }, alert.items);
    if (result?.sent) {
      await db.query(
        `UPDATE order_alert_deliveries SET status='sent', sent_at=NOW(), error_message=NULL
          WHERE tenant_id=? AND shop_id=? AND order_sn=? AND alert_type='NEW_ORDER'`,
        [tenantId, shopId, orderSn]
      );
      return { sent: true };
    }
    const reason = String(result?.reason || 'telegram delivery skipped').slice(0, 500);
    await db.query(
      `UPDATE order_alert_deliveries SET status='failed', error_message=?
        WHERE tenant_id=? AND shop_id=? AND order_sn=? AND alert_type='NEW_ORDER'`,
      [reason, tenantId, shopId, orderSn]
    );
    return { failed: true, reason };
  } catch (error) {
    console.warn(`[NewOrderAlert] tenant=${tenantId} shop=${shopId} order=${orderSn}: ${error.message}`);
    return { failed: true, reason: error.message };
  }
}

module.exports = {
  ensureOrderAlertDeliveriesTable,
  loadNewOrderAlert,
  notifyNewOrderOnce,
};
