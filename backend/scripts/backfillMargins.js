require('dotenv').config();

const db = require('../src/config/database');

const APPLY = process.argv.includes('--apply');
const DRY_RUN = process.argv.includes('--dry-run') || !APPLY;

function parseNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function getMarginStatus(order) {
  if (order.order_status === 'CANCELLED') return 'cancelled';

  const actualShippingFee = parseNullableNumber(order.actual_shipping_fee);
  return actualShippingFee !== null && actualShippingFee > 0 ? 'confirmed' : 'pending';
}

function formatValue(value) {
  return value === null || value === undefined ? 'NULL' : value;
}

async function loadExchangeRateMap() {
  const [rows] = await db.query(
    'SELECT currency, rate_to_krw FROM exchange_rates'
  );

  const rateMap = new Map();
  for (const row of rows) {
    const rate = parseNullableNumber(row.rate_to_krw);
    if (row.currency && rate !== null) {
      rateMap.set(String(row.currency), rate);
    }
  }
  return rateMap;
}

async function loadGeneralTargets() {
  const [rows] = await db.query(
    `SELECT
       order_sn, shop_id, currency, escrow_amount, total_cost_price,
       total_discounted_price, actual_shipping_fee, order_status,
       margin_status, net_profit, product_profit
     FROM orders
     WHERE escrow_amount IS NOT NULL
       AND escrow_amount > 0
       AND total_cost_price IS NOT NULL
       AND total_discounted_price IS NOT NULL
       AND order_status != 'CANCELLED'
     ORDER BY update_time DESC, order_sn ASC`
  );

  return rows;
}

async function countCancelledTargets() {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count
     FROM orders
     WHERE order_status = 'CANCELLED'
       AND (margin_status IS NULL OR margin_status != 'cancelled')`
  );

  return Number(rows[0]?.count || 0);
}

async function applyCancelledFix() {
  const [result] = await db.query(
    `UPDATE orders
     SET margin_status = 'cancelled',
         net_profit = NULL,
         product_profit = NULL
     WHERE order_status = 'CANCELLED'
       AND (margin_status IS NULL OR margin_status != 'cancelled')`
  );

  return result.affectedRows;
}

async function applyMarginUpdate(order, expected, newMarginStatus, updateProfit) {
  if (updateProfit) {
    const [result] = await db.query(
      `UPDATE orders
       SET net_profit = ?,
           product_profit = ?,
           margin_status = ?
       WHERE order_sn = ?
         AND shop_id = ?`,
      [
        expected.netProfit,
        expected.productProfit,
        newMarginStatus,
        order.order_sn,
        order.shop_id,
      ]
    );
    return result.affectedRows;
  }

  const [result] = await db.query(
    `UPDATE orders
     SET margin_status = ?
     WHERE order_sn = ?
       AND shop_id = ?`,
    [newMarginStatus, order.order_sn, order.shop_id]
  );
  return result.affectedRows;
}

function buildSample(order, rateToKrw, expected, newMarginStatus, updateReason) {
  return {
    order_sn: order.order_sn,
    currency: order.currency,
    escrow_amount: parseNullableNumber(order.escrow_amount),
    rate_to_krw: rateToKrw ?? null,
    total_cost_price: parseNullableNumber(order.total_cost_price),
    total_discounted_price: parseNullableNumber(order.total_discounted_price),
    existing_net_profit: parseNullableNumber(order.net_profit),
    expected_net_profit: expected?.netProfit ?? null,
    existing_product_profit: parseNullableNumber(order.product_profit),
    expected_product_profit: expected?.productProfit ?? null,
    old_margin_status: order.margin_status,
    new_margin_status: newMarginStatus,
    update_reason: updateReason,
  };
}

function printSample(sample) {
  console.log(
    `[MarginBackfill] SAMPLE order_sn=${sample.order_sn}` +
    ` currency=${formatValue(sample.currency)}` +
    ` escrow_amount=${formatValue(sample.escrow_amount)}` +
    ` rate_to_krw=${formatValue(sample.rate_to_krw)}` +
    ` total_cost_price=${formatValue(sample.total_cost_price)}` +
    ` total_discounted_price=${formatValue(sample.total_discounted_price)}` +
    ` existing_net_profit=${formatValue(sample.existing_net_profit)}` +
    ` expected_net_profit=${formatValue(sample.expected_net_profit)}` +
    ` existing_product_profit=${formatValue(sample.existing_product_profit)}` +
    ` expected_product_profit=${formatValue(sample.expected_product_profit)}` +
    ` old_margin_status=${formatValue(sample.old_margin_status)}` +
    ` new_margin_status=${formatValue(sample.new_margin_status)}` +
    ` update_reason=${sample.update_reason}`
  );
}

async function main() {
  console.log(`[MarginBackfill] mode=${APPLY ? 'apply' : 'dry-run'}`);

  const rateMap = await loadExchangeRateMap();
  const targets = await loadGeneralTargets();
  const cancelledTargetCount = await countCancelledTargets();
  const samples = [];
  const stats = {
    general_target: targets.length,
    would_update: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    missing_rate: 0,
    status_only: 0,
    profit_new: 0,
    profit_recalc: 0,
    no_change: 0,
    cancelled_target: cancelledTargetCount,
    cancelled_updated: 0,
  };

  for (const order of targets) {
    try {
      const newMarginStatus = getMarginStatus(order);
      const rateToKrw = order.currency ? rateMap.get(String(order.currency)) : null;

      if (rateToKrw === null || rateToKrw === undefined) {
        stats.missing_rate++;
        stats.skipped++;
        if (samples.length < 10) {
          samples.push(buildSample(order, rateToKrw, null, newMarginStatus, 'skip_no_rate'));
        }
        console.log(`[MarginBackfill] SKIP_NO_RATE order_sn=${order.order_sn} currency=${formatValue(order.currency)}`);
        continue;
      }

      const escrowAmount = parseNullableNumber(order.escrow_amount);
      const totalCostPrice = parseNullableNumber(order.total_cost_price);
      const totalDiscountedPrice = parseNullableNumber(order.total_discounted_price);
      const expected = {
        netProfit: roundCurrency((escrowAmount * rateToKrw) - totalCostPrice),
        productProfit: roundCurrency((escrowAmount * rateToKrw) - totalDiscountedPrice),
      };

      const existingNetProfit = parseNullableNumber(order.net_profit);
      const existingProductProfit = parseNullableNumber(order.product_profit);
      const isMissingProfit = existingNetProfit === null || existingProductProfit === null;
      const isProfitDiff = existingNetProfit !== null && Math.abs(expected.netProfit - existingNetProfit) > 1;
      const isStatusDiff = order.margin_status !== newMarginStatus;

      let updateReason = null;
      let updateProfit = false;
      if (isMissingProfit) {
        updateReason = 'fill_missing_profit';
        updateProfit = true;
        stats.profit_new++;
      } else if (isProfitDiff) {
        updateReason = 'recalc_profit_diff_gt_1';
        updateProfit = true;
        stats.profit_recalc++;
      } else if (isStatusDiff) {
        updateReason = 'status_only';
        stats.status_only++;
      } else {
        updateReason = 'no_change';
        stats.no_change++;
        stats.skipped++;
      }

      if (updateReason !== 'no_change') {
        stats.would_update++;
        if (APPLY) {
          const affectedRows = await applyMarginUpdate(order, expected, newMarginStatus, updateProfit);
          stats.updated += affectedRows > 0 ? 1 : 0;
        }
      }

      if (samples.length < 10) {
        samples.push(buildSample(order, rateToKrw, expected, newMarginStatus, updateReason));
      }
    } catch (err) {
      stats.failed++;
      console.log(`[MarginBackfill] SKIP_ERROR order_sn=${order.order_sn} error="${err.message}"`);
    }
  }

  if (APPLY) {
    stats.cancelled_updated = await applyCancelledFix();
  }

  console.log(`[MarginBackfill] general_target=${stats.general_target}`);
  console.log(`[MarginBackfill] ${APPLY ? 'updated' : 'would_update'}=${APPLY ? stats.updated : stats.would_update}`);
  console.log(`[MarginBackfill] skipped=${stats.skipped}`);
  console.log(`[MarginBackfill] failed=${stats.failed}`);
  console.log(`[MarginBackfill] missing_rate=${stats.missing_rate}`);
  console.log(`[MarginBackfill] status_only=${stats.status_only}`);
  console.log(`[MarginBackfill] profit_new=${stats.profit_new}`);
  console.log(`[MarginBackfill] profit_recalc=${stats.profit_recalc}`);
  console.log(`[MarginBackfill] cancelled_target=${stats.cancelled_target}`);
  console.log(`[MarginBackfill] cancelled_updated=${stats.cancelled_updated}`);
  for (const sample of samples) {
    printSample(sample);
  }

  await db.end();
}

main().catch(async err => {
  console.error(`[MarginBackfill] FATAL error="${err.message}"`);
  try {
    await db.end();
  } catch (_) {}
  process.exit(1);
});
