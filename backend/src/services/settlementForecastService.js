const db = require('../config/database');
const { ensurePaymentBalanceTable } = require('./paymentBalanceService');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const FORECAST_BASELINE_KST = '2026-07-20 00:00:00';
const FORECAST_BASELINE_UTC = '2026-07-19 15:00:00';
const PAYMENT_INITIATED_STATUSES = ['Payment initiated', '撥款進行中'];
let completionEventsTableReady = null;

function toSqlUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function getKstWeekWindows(now = new Date()) {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const day = kst.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const thisWeekStart = new Date(Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate() - daysSinceMonday,
  ) - KST_OFFSET_MS);
  const nextWeekStart = new Date(thisWeekStart.getTime() + (7 * 24 * 60 * 60 * 1000));
  const previousWeekStart = new Date(thisWeekStart.getTime() - (7 * 24 * 60 * 60 * 1000));

  return {
    next_payout: {
      completed_from: toSqlUtc(previousWeekStart),
      completed_to: toSqlUtc(thisWeekStart),
      period_label: `${toKstDate(previousWeekStart)} ~ ${toKstDate(new Date(thisWeekStart.getTime() - 1))}`,
    },
    following_payout: {
      completed_from: toSqlUtc(thisWeekStart),
      completed_to: toSqlUtc(nextWeekStart),
      period_label: `${toKstDate(thisWeekStart)} ~ ${toKstDate(new Date(nextWeekStart.getTime() - 1))}`,
    },
  };
}

function toKstDate(date) {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

async function ensureOrderCompletionEventsTable() {
  if (completionEventsTableReady) return completionEventsTableReady;

  completionEventsTableReady = db.query(`
    CREATE TABLE IF NOT EXISTS order_completion_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      shop_id BIGINT NOT NULL,
      order_sn VARCHAR(50) NOT NULL,
      completed_at DATETIME NOT NULL,
      source_update_time BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_completion_event_order (tenant_id, shop_id, order_sn),
      INDEX idx_completion_event_tenant_time (tenant_id, completed_at),
      INDEX idx_completion_event_shop_time (tenant_id, shop_id, completed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch((err) => {
    completionEventsTableReady = null;
    throw err;
  });
  return completionEventsTableReady;
}

function completionDateFromUpdateTime(updateTime) {
  const seconds = Number(updateTime || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

async function recordOrderCompletion({ tenantId, shopId, orderSn, updateTime }) {
  await ensureOrderCompletionEventsTable();
  const completedAt = completionDateFromUpdateTime(updateTime);
  const [result] = await db.query(
    `INSERT IGNORE INTO order_completion_events
      (tenant_id, shop_id, order_sn, completed_at, source_update_time)
     VALUES (?, ?, ?, ?, ?)`,
    [tenantId, shopId, orderSn, toSqlUtc(completedAt), Number(updateTime || 0) || null]
  );
  return result.affectedRows === 1;
}

async function getSettlementForecast(tenantId, now = new Date()) {
  await ensureOrderCompletionEventsTable();
  await ensurePaymentBalanceTable();
  const windows = getKstWeekWindows(now);
  const [rates] = await db.query('SELECT currency, rate_to_krw FROM exchange_rates');
  const rateMap = new Map(rates.map((row) => [String(row.currency).toUpperCase(), Number(row.rate_to_krw || 0)]));
  const usdRate = rateMap.get('USD') || null;

  async function getWindow(key, window) {
    const from = window.completed_from < FORECAST_BASELINE_UTC ? FORECAST_BASELINE_UTC : window.completed_from;
    const to = window.completed_to;
    const isBeforeBaseline = to <= FORECAST_BASELINE_UTC;
    const [rows] = await db.query(
      `SELECT p.shop_id, s.alias, s.shop_name, s.region, p.currency,
              COUNT(*) AS order_count,
              COALESCE(SUM(p.to_release_amount), 0) AS local_amount
       FROM shopee_payment_income_items p
       INNER JOIN shops s ON s.tenant_id = p.tenant_id AND s.shop_id = p.shop_id
       WHERE p.tenant_id = ?
         AND p.status IN (?, ?)
         AND p.creation_at >= ? AND p.creation_at < ?
         AND ? = 0
       GROUP BY p.shop_id, s.alias, s.shop_name, s.region, p.currency
       ORDER BY CASE s.region WHEN 'SG' THEN 1 WHEN 'MY' THEN 2 WHEN 'PH' THEN 3 WHEN 'TW' THEN 4 ELSE 99 END, p.shop_id`,
      [tenantId, ...PAYMENT_INITIATED_STATUSES, from, to, isBeforeBaseline ? 1 : 0]
    );

    let krwAmount = 0;
    let usdAmount = 0;
    let conversionAvailable = Boolean(usdRate);
    const shops = rows.map((row) => {
      const localAmount = Number(row.local_amount || 0);
      const localRate = rateMap.get(String(row.currency || '').toUpperCase());
      const convertible = Boolean(localRate && usdRate);
      const usd = convertible ? (localAmount * localRate) / usdRate : null;
      const krw = convertible ? localAmount * localRate : null;
      if (convertible) {
        usdAmount += usd;
        krwAmount += krw;
      } else {
        conversionAvailable = false;
      }
      return { ...row, local_amount: localAmount, usd_amount: usd, krw_amount: krw };
    });

    return {
      key,
      period_label: window.period_label,
      basis: 'payment_initiated',
      baseline_kst: FORECAST_BASELINE_KST,
      order_count: rows.reduce((sum, row) => sum + Number(row.order_count || 0), 0),
      krw_amount: conversionAvailable ? krwAmount : null,
      usd_amount: conversionAvailable ? usdAmount : null,
      conversion_available: conversionAvailable,
      shops,
    };
  }

  return {
    timezone: 'Asia/Seoul',
    next_payout: await getWindow('next_payout', windows.next_payout),
    following_payout: await getWindow('following_payout', windows.following_payout),
  };
}

module.exports = {
  ensureOrderCompletionEventsTable,
  getKstWeekWindows,
  getSettlementForecast,
  recordOrderCompletion,
};
