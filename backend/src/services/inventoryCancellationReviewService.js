const db = require('../config/database');

const DECISIONS = Object.freeze({
  AUTO_RESTORED: 'AUTO_RESTORED',
  RESTORE_PENDING: 'RESTORE_PENDING',
  DO_NOT_RESTORE: 'DO_NOT_RESTORE',
  RESTORED_MANUALLY: 'RESTORED_MANUALLY',
});

let tableReady;

function ensureTable() {
  if (!tableReady) {
    tableReady = db.query(`
      CREATE TABLE IF NOT EXISTS inventory_cancellation_reviews (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        shop_id BIGINT NOT NULL,
        order_sn VARCHAR(50) NOT NULL,
        previous_order_status VARCHAR(30) NOT NULL,
        decision VARCHAR(30) NOT NULL,
        decision_reason VARCHAR(255) NOT NULL,
        cancelled_update_time BIGINT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        resolved_at DATETIME NULL,
        UNIQUE KEY uq_inventory_cancellation_review (tenant_id, shop_id, order_sn),
        INDEX idx_inventory_cancellation_decision (tenant_id, decision, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(error => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

function classifyCancellation(previousOrderStatus) {
  if (previousOrderStatus === 'READY_TO_SHIP') {
    return { decision: DECISIONS.AUTO_RESTORED, reason: '출고 접수 전 취소' };
  }
  if (previousOrderStatus === 'PROCESSED') {
    return { decision: DECISIONS.RESTORE_PENDING, reason: '출고 접수 후 취소' };
  }
  return { decision: DECISIONS.DO_NOT_RESTORE, reason: '물류 진행 이후 취소' };
}

async function recordCancellationReview({ tenantId, shopId, orderSn, previousOrderStatus, updateTime, decision, reason }) {
  await ensureTable();
  await db.query(
    `INSERT INTO inventory_cancellation_reviews
      (tenant_id, shop_id, order_sn, previous_order_status, decision, decision_reason, cancelled_update_time)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
    [tenantId, shopId, orderSn, previousOrderStatus, decision, reason, updateTime || null]
  );
}

async function getCancellationReviews({ tenantId, decision = '', limit = 100 }) {
  await ensureTable();
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const params = [tenantId];
  let decisionSql = '';
  if (decision && Object.values(DECISIONS).includes(decision)) {
    decisionSql = ' AND r.decision = ?';
    params.push(decision);
  }
  params.push(safeLimit);
  const [rows] = await db.query(
    `SELECT r.*, o.region, o.order_status, o.order_created_at,
            GROUP_CONCAT(DISTINCT COALESCE(oi.model_sku, oi.item_sku) ORDER BY oi.id SEPARATOR ', ') AS skus,
            GROUP_CONCAT(DISTINCT oi.item_name ORDER BY oi.id SEPARATOR ' / ') AS item_names,
            SUM(COALESCE(oi.model_quantity_purchased, 0)) AS total_quantity
       FROM inventory_cancellation_reviews r
       LEFT JOIN orders o ON o.tenant_id = r.tenant_id AND o.shop_id = r.shop_id AND o.order_sn = r.order_sn
       LEFT JOIN order_items oi ON oi.tenant_id = r.tenant_id AND oi.shop_id = r.shop_id AND oi.order_sn = r.order_sn
      WHERE r.tenant_id = ?${decisionSql}
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT ?`,
    params
  );
  return rows;
}

async function markCancellationReviewRestored({ tenantId, shopId, orderSn }) {
  await ensureTable();
  const [result] = await db.query(
    `UPDATE inventory_cancellation_reviews
        SET decision = ?, decision_reason = '실물 회수 확인 후 수동 복원', resolved_at = NOW()
      WHERE tenant_id = ? AND shop_id = ? AND order_sn = ? AND decision = ?`,
    [DECISIONS.RESTORED_MANUALLY, tenantId, shopId, orderSn, DECISIONS.RESTORE_PENDING]
  );
  return result.affectedRows === 1;
}

module.exports = {
  DECISIONS,
  classifyCancellation,
  recordCancellationReview,
  getCancellationReviews,
  markCancellationReviewRestored,
};
