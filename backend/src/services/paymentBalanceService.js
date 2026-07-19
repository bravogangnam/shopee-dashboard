const db = require('../config/database');
const { buildUrl } = require('../utils/shopeeSignature');
const { callWithRetry, shopeeAxios } = require('../utils/apiWrapper');
const { getOrRefreshShopToken, refreshShopToken } = require('./shopeeAuth');

// Shopee Income Detail shows this status for the part of To Release that is
// already available to use. Processing statuses are intentionally excluded.
const BALANCE_STATUSES = new Set(['Payment initiated']);
const REGION_CURRENCY = {
  SG: 'SGD',
  MY: 'MYR',
  PH: 'PHP',
  TW: 'TWD',
};

let paymentBalanceTableReady = null;

async function ensurePaymentBalanceTable() {
  if (paymentBalanceTableReady) return paymentBalanceTableReady;

  paymentBalanceTableReady = db.query(`
    CREATE TABLE IF NOT EXISTS shopee_payment_balance_snapshots (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      shop_id BIGINT NOT NULL,
      currency VARCHAR(12) NULL,
      balance_amount DECIMAL(18, 4) NULL,
      balance_item_count INT NOT NULL DEFAULT 0,
      synced_at DATETIME NULL,
      last_attempted_at DATETIME NULL,
      last_error VARCHAR(1000) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payment_balance_tenant_shop (tenant_id, shop_id),
      INDEX idx_payment_balance_tenant_synced (tenant_id, synced_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch((err) => {
    paymentBalanceTableReady = null;
    throw err;
  });

  return paymentBalanceTableReady;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function calculateAvailableBalance(items, fallbackCurrency = null) {
  const availableItems = (Array.isArray(items) ? items : []).filter((item) =>
    BALANCE_STATUSES.has(String(item?.status || '').trim())
  );
  const currencies = [...new Set(availableItems
    .map((item) => String(item?.currency || '').trim().toUpperCase())
    .filter(Boolean))];

  if (currencies.length > 1) {
    throw new Error(`Multiple currencies returned for one shop: ${currencies.join(', ')}`);
  }

  return {
    currency: currencies[0] || fallbackCurrency || null,
    balanceAmount: availableItems.reduce((sum, item) => sum + toFiniteNumber(item?.to_release_amount), 0),
    itemCount: availableItems.length,
  };
}

function normalizeIncomeDetailResponse(payload) {
  const response = payload?.response || {};
  return {
    items: Array.isArray(response.list) ? response.list : [],
    hasMore: Boolean(response.more),
    nextCursor: String(response.next_cursor || ''),
  };
}

async function fetchIncomeDetailPage({ shopId, accessToken, cursor }) {
  const path = '/api/v2/payment/get_income_detail';
  const params = { page_size: '100', cursor: cursor || '' };
  const url = buildUrl(path, params, 'shop', accessToken, shopId);
  return callWithRetry(
    () => shopeeAxios.get(url),
    { context: `payment.get_income_detail[shop=${shopId}]` }
  );
}

async function fetchIncomeDetailItems({ tenantId, shopId }) {
  let accessToken = await getOrRefreshShopToken(shopId, { tenantId });
  if (!accessToken) throw new Error('Shop access token is unavailable');

  const items = [];
  let cursor = '';
  let page = 0;

  while (true) {
    let payload;
    try {
      payload = await fetchIncomeDetailPage({ shopId, accessToken, cursor });
    } catch (err) {
      if (!['error_auth', 'invalid_access_token', 'error_permission'].includes(err.shopeeError)) throw err;
      const refreshed = await refreshShopToken(shopId, { tenantId });
      if (!refreshed) throw err;
      accessToken = await getOrRefreshShopToken(shopId, { tenantId });
      if (!accessToken) throw err;
      payload = await fetchIncomeDetailPage({ shopId, accessToken, cursor });
    }

    const normalized = normalizeIncomeDetailResponse(payload);
    items.push(...normalized.items);
    page += 1;
    if (!normalized.hasMore) break;
    if (!normalized.nextCursor || page >= 100) {
      throw new Error('Income detail pagination cursor is invalid');
    }
    cursor = normalized.nextCursor;
  }

  return items;
}

async function getActiveShops(tenantId) {
  const [shops] = await db.query(
    `SELECT shop_id, shop_name, alias, region
     FROM shops
     WHERE tenant_id = ? AND is_active = 1
     ORDER BY CASE region
       WHEN 'SG' THEN 1
       WHEN 'MY' THEN 2
       WHEN 'PH' THEN 3
       WHEN 'TW' THEN 4
       ELSE 99
     END, shop_id`,
    [tenantId]
  );
  return shops;
}

async function saveSuccessfulSnapshot({ tenantId, shopId, currency, balanceAmount, itemCount }) {
  await db.query(
    `INSERT INTO shopee_payment_balance_snapshots
       (tenant_id, shop_id, currency, balance_amount, balance_item_count, synced_at, last_attempted_at, last_error)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW(), NULL)
     ON DUPLICATE KEY UPDATE
       currency = VALUES(currency),
       balance_amount = VALUES(balance_amount),
       balance_item_count = VALUES(balance_item_count),
       synced_at = NOW(),
       last_attempted_at = NOW(),
       last_error = NULL`,
    [tenantId, shopId, currency, balanceAmount, itemCount]
  );
}

async function saveFailedAttempt({ tenantId, shopId, message }) {
  await db.query(
    `INSERT INTO shopee_payment_balance_snapshots
       (tenant_id, shop_id, last_attempted_at, last_error)
     VALUES (?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       last_attempted_at = NOW(),
       last_error = VALUES(last_error)`,
    [tenantId, shopId, String(message || 'Payment API refresh failed').slice(0, 1000)]
  );
}

async function refreshPaymentBalances(tenantId) {
  await ensurePaymentBalanceTable();
  const shops = await getActiveShops(tenantId);
  const results = [];

  for (const shop of shops) {
    try {
      const items = await fetchIncomeDetailItems({ tenantId, shopId: shop.shop_id });
      const snapshot = calculateAvailableBalance(items, REGION_CURRENCY[shop.region] || null);
      await saveSuccessfulSnapshot({ tenantId, shopId: shop.shop_id, ...snapshot });
      console.log(`[PaymentBalance] tenant_id=${tenantId} shop_id=${shop.shop_id} mode=manual_refresh items=${items.length} available_items=${snapshot.itemCount} success`);
      results.push({ shop_id: shop.shop_id, success: true });
    } catch (err) {
      await saveFailedAttempt({ tenantId, shopId: shop.shop_id, message: err.message });
      console.error(`[PaymentBalance] tenant_id=${tenantId} shop_id=${shop.shop_id} mode=manual_refresh failed: ${err.message}`);
      results.push({ shop_id: shop.shop_id, success: false, error: err.message });
    }
  }

  return results;
}

function summarizePaymentBalances(rows, rates) {
  const rateMap = new Map(rates.map((rate) => [String(rate.currency).toUpperCase(), toFiniteNumber(rate.rate_to_krw)]));
  const usdRate = rateMap.get('USD') || null;
  const currencyTotals = new Map();
  let totalUsd = 0;
  let totalKrw = 0;
  let conversionAvailable = Boolean(usdRate);

  const shops = rows.map((row) => {
    const amount = row.balance_amount === null || row.balance_amount === undefined ? null : toFiniteNumber(row.balance_amount);
    const currency = row.currency ? String(row.currency).toUpperCase() : null;
    const localRate = currency ? rateMap.get(currency) : null;
    const canConvert = amount !== null && localRate && usdRate;
    const usdAmount = canConvert ? (amount * localRate) / usdRate : null;
    const krwAmount = canConvert ? usdAmount * usdRate : null;

    if (amount !== null && currency) {
      currencyTotals.set(currency, (currencyTotals.get(currency) || 0) + amount);
    }
    if (canConvert) {
      totalUsd += usdAmount;
      totalKrw += krwAmount;
    } else if (amount !== null) {
      conversionAvailable = false;
    }

    return {
      ...row,
      balance_amount: amount,
      usd_amount: usdAmount,
      krw_amount: krwAmount,
      conversion_available: Boolean(canConvert),
    };
  });

  return {
    shops,
    totals: {
      by_currency: [...currencyTotals.entries()].map(([currency, amount]) => ({ currency, amount })),
      usd_amount: conversionAvailable ? totalUsd : null,
      krw_amount: conversionAvailable ? totalKrw : null,
      conversion_available: conversionAvailable,
      missing_rates: [...new Set(shops
        .filter((shop) => shop.balance_amount !== null && (!shop.currency || !rateMap.get(shop.currency) || !usdRate))
        .flatMap((shop) => [shop.currency && !rateMap.get(shop.currency) ? shop.currency : null, !usdRate ? 'USD' : null])
        .filter(Boolean))],
    },
  };
}

async function getPaymentBalanceSnapshot(tenantId) {
  await ensurePaymentBalanceTable();
  const [rows] = await db.query(
    `SELECT s.shop_id, s.shop_name, s.alias, s.region,
            p.currency, p.balance_amount, p.balance_item_count,
            p.synced_at, p.last_attempted_at, p.last_error
     FROM shops s
     LEFT JOIN shopee_payment_balance_snapshots p
       ON p.tenant_id = s.tenant_id AND p.shop_id = s.shop_id
     WHERE s.tenant_id = ? AND s.is_active = 1
     ORDER BY CASE s.region
       WHEN 'SG' THEN 1
       WHEN 'MY' THEN 2
       WHEN 'PH' THEN 3
       WHEN 'TW' THEN 4
       ELSE 99
     END, s.shop_id`,
    [tenantId]
  );
  const [rates] = await db.query('SELECT currency, rate_to_krw FROM exchange_rates');
  return summarizePaymentBalances(rows, rates);
}

module.exports = {
  BALANCE_STATUSES,
  calculateAvailableBalance,
  ensurePaymentBalanceTable,
  getPaymentBalanceSnapshot,
  refreshPaymentBalances,
  summarizePaymentBalances,
};
