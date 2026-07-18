const crypto = require('crypto');
const db = require('../config/database');
const { calculatePushAuthorization, verifyPushAuthorization } = require('./shopeePushAuth');
const { getOrRefreshShopToken } = require('./shopeeAuth');
const {
  getOrderDetail,
  getEscrowDetail,
  getTrackingNumber,
  mapOrderToDb,
} = require('./shopeeOrder');
const { applyShopeeOrderSnapshot } = require('./orderSnapshotService');
const { publishOrderChange } = require('./orderEventHub');
const { notifyNewOrderOnce } = require('./newOrderAlertService');
const { OPERATIONAL_PUSH_CODES: SUPPORTED_CODES } = require('./shopeePushRequest');

const processingKeys = new Set();
let pushEventsTableReady = null;

async function ensurePushEventsTable() {
  if (pushEventsTableReady) return pushEventsTableReady;
  pushEventsTableReady = db.query(`
    CREATE TABLE IF NOT EXISTS shopee_push_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      shop_id BIGINT NOT NULL,
      code INT NOT NULL,
      order_sn VARCHAR(50) NULL,
      event_update_time BIGINT NULL,
      payload_hash CHAR(64) NOT NULL,
      status ENUM('queued','processing','completed','failed','ignored') NOT NULL DEFAULT 'queued',
      error_message VARCHAR(500) NULL,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME NULL,
      UNIQUE KEY uq_shopee_push_payload (shop_id, code, payload_hash),
      INDEX idx_shopee_push_order (tenant_id, shop_id, order_sn, event_update_time),
      INDEX idx_shopee_push_status (status, received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(err => {
    pushEventsTableReady = null;
    throw err;
  });
  return pushEventsTableReady;
}

async function getPushContext(shopId) {
  const [rows] = await db.query(
    `SELECT s.tenant_id, s.shop_id, s.region, s.is_active, ma.partner_key
     FROM shops s
     JOIN main_account ma
       ON ma.tenant_id = s.tenant_id
      AND ma.id = s.main_account_id
     WHERE s.shop_id = ?
     LIMIT 1`,
    [shopId]
  );
  return rows[0] || null;
}

async function registerPushEvent({ context, payload, rawBody }) {
  await ensurePushEventsTable();
  const code = Number(payload.code);
  const orderSn = String(payload?.data?.ordersn || payload?.data?.order_sn || '').trim() || null;
  const eventUpdateTime = Number(payload?.data?.update_time || payload?.timestamp || 0) || null;
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const [result] = await db.query(
    `INSERT IGNORE INTO shopee_push_events
       (tenant_id, shop_id, code, order_sn, event_update_time, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [context.tenant_id, context.shop_id, code, orderSn, eventUpdateTime, payloadHash]
  );
  if (result.affectedRows !== 1) {
    const [duplicates] = await db.query(
      `SELECT id, order_sn, event_update_time, status
       FROM shopee_push_events
       WHERE shop_id = ? AND code = ? AND payload_hash = ?
       LIMIT 1`,
      [context.shop_id, code, payloadHash]
    );
    const duplicate = duplicates[0];
    if (!duplicate || !['queued', 'failed'].includes(duplicate.status)) return null;
    await db.query(
      "UPDATE shopee_push_events SET status='queued', error_message=NULL, processed_at=NULL WHERE id=?",
      [duplicate.id]
    );
    return {
      id: duplicate.id,
      code,
      orderSn: duplicate.order_sn,
      eventUpdateTime: Number(duplicate.event_update_time || 0) || null,
    };
  }
  return { id: result.insertId, code, orderSn, eventUpdateTime };
}

async function resolveDisplayStatus(order, shopId, accessToken) {
  if (order.order_status !== 'READY_TO_SHIP') return order.order_status;
  const { getShippingParameter } = require('./shopeeLogistics');
  try {
    await getShippingParameter(shopId, order.order_sn, accessToken);
    return 'READY_TO_SHIP';
  } catch (err) {
    if (/package.*ready to be shipped|buyer TW KYC|\bKYC\b/i.test(err.message || '')) return 'PENDING';
    return 'READY_TO_SHIP';
  }
}

async function syncPushedOrder({ context, event }) {
  if (!event.orderSn) return { ignored: true, reason: 'push has no order_sn' };
  const accessToken = await getOrRefreshShopToken(context.shop_id, { tenantId: context.tenant_id });
  if (!accessToken) throw new Error('shop access token unavailable');
  const details = await getOrderDetail(context.shop_id, [event.orderSn], accessToken);
  const order = details[0];
  if (!order) throw new Error('order detail not available yet');
  if (event.code === 3 && event.eventUpdateTime && Number(order.update_time || 0) < event.eventUpdateTime) {
    throw new Error('order detail has not caught up with push event yet');
  }

  let escrow = null;
  if (['COMPLETED', 'SHIPPED', 'PROCESSED', 'TO_CONFIRM_RECEIVE', 'READY_TO_SHIP'].includes(order.order_status)) {
    try { escrow = await getEscrowDetail(context.shop_id, event.orderSn, accessToken); } catch (_) {}
  }
  const { orderRow, itemRows } = mapOrderToDb(order, context.shop_id, context.region, escrow);
  orderRow.display_status = await resolveDisplayStatus(order, context.shop_id, accessToken);
  orderRow.display_status_reason = orderRow.display_status === 'PENDING'
    ? 'Shipping parameters can only be obtained when package is ready to be shipped'
    : null;
  orderRow.display_status_checked_at = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (!orderRow.tracking_number && (event.code === 4 || event.code === 15)) {
    orderRow.tracking_number = await getTrackingNumber(context.shop_id, event.orderSn, accessToken);
  }

  const applied = await applyShopeeOrderSnapshot({
    tenantId: context.tenant_id,
    shopId: context.shop_id,
    orderRow,
    itemRows,
    source: `push:${event.code}`,
  });
  const becameReadyToShip = orderRow.order_status === 'READY_TO_SHIP' &&
    (applied.created || applied.previousOrderStatus !== 'READY_TO_SHIP');
  if (becameReadyToShip) {
    await notifyNewOrderOnce({
      tenantId: context.tenant_id,
      shopId: context.shop_id,
      orderSn: event.orderSn,
    });
  }
  return {
    inserted: applied.created ? 1 : 0,
    updated: applied.updated ? 1 : 0,
    ignored: applied.stale && !applied.repairedItems && !applied.supplemented,
    reason: applied.stale ? 'older event' : null,
    displayStatus: applied.displayStatus,
  };
}

async function processPushEvent(context, event) {
  const key = `${context.tenant_id}:${context.shop_id}:${event.orderSn || '-'}`;
  if (processingKeys.has(key)) throw new Error('matching push is already processing');
  processingKeys.add(key);
  try {
    await db.query("UPDATE shopee_push_events SET status='processing' WHERE id=?", [event.id]);
    const result = await syncPushedOrder({ context, event });
    await db.query(
      `UPDATE shopee_push_events
       SET status=?, processed_at=NOW(), error_message=NULL
       WHERE id=?`,
      [result.ignored ? 'ignored' : 'completed', event.id]
    );
    publishOrderChange(context.tenant_id, {
      shop_id: context.shop_id,
      order_sn: event.orderSn,
      code: event.code,
      update_time: event.eventUpdateTime,
    });
  } catch (err) {
    const attempt = Number(event.attempt || 0) + 1;
    const retryDelays = [5000, 30000, 120000];
    if (attempt <= retryDelays.length) {
      await db.query(
        "UPDATE shopee_push_events SET status='queued', error_message=? WHERE id=?",
        [`retry ${attempt}: ${String(err.message || err).slice(0, 450)}`, event.id]
      );
      setTimeout(() => {
        processPushEvent(context, { ...event, attempt }).catch(retryErr => {
          console.error(`[ShopeePush] retry failed shop=${context.shop_id} code=${event.code}: ${retryErr.message}`);
        });
      }, retryDelays[attempt - 1]);
      return;
    }
    await db.query(
      "UPDATE shopee_push_events SET status='failed', processed_at=NOW(), error_message=? WHERE id=?",
      [String(err.message || err).slice(0, 500), event.id]
    );
    console.error(`[ShopeePush] processing failed shop=${context.shop_id} code=${event.code}: ${err.message}`);
  } finally {
    processingKeys.delete(key);
  }
}

function enqueuePushEvent(context, event) {
  setImmediate(() => {
    processPushEvent(context, { ...event, attempt: 0 }).catch(err => {
      console.error(`[ShopeePush] enqueue failed shop=${context.shop_id} code=${event.code}: ${err.message}`);
    });
  });
}

module.exports = {
  SUPPORTED_CODES,
  calculatePushAuthorization,
  verifyPushAuthorization,
  ensurePushEventsTable,
  getPushContext,
  registerPushEvent,
  enqueuePushEvent,
  syncPushedOrder,
};
