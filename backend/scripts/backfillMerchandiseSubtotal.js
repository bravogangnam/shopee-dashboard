require('dotenv').config();

const db = require('../src/config/database');
const { getEscrowDetail } = require('../src/services/shopeeOrder');
const { getOrRefreshShopToken } = require('../src/services/shopeeAuth');

const APPLY = process.argv.includes('--apply');
const DRY_RUN = process.argv.includes('--dry-run') || !APPLY;

function parseSubtotal(escrow) {
  const buyerPaymentInfo = escrow?.buyer_payment_info || {};
  const raw = buyerPaymentInfo.merchandise_subtotal ?? buyerPaymentInfo.merchant_subtotal ?? null;
  if (raw === null || raw === undefined || raw === '') return null;

  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function loadTargets() {
  const [rows] = await db.query(
    `SELECT order_sn, shop_id, region, order_status
     FROM orders
     WHERE merchandise_subtotal IS NULL
       AND order_status NOT IN ('UNPAID', 'CANCELLED')
     ORDER BY order_created_at DESC, order_sn ASC`
  );

  return rows;
}

async function updateSubtotal(order, subtotal) {
  const [result] = await db.query(
    `UPDATE orders
     SET merchandise_subtotal = ?
     WHERE order_sn = ?
       AND shop_id = ?
       AND merchandise_subtotal IS NULL
       AND order_status NOT IN ('UNPAID', 'CANCELLED')`,
    [subtotal, order.order_sn, order.shop_id]
  );

  return result.affectedRows;
}

async function main() {
  if (!APPLY && !DRY_RUN) {
    throw new Error('Use --dry-run or --apply');
  }

  console.log(`[MerchandiseSubtotalBackfill] mode=${APPLY ? 'apply' : 'dry-run'}`);

  const targets = await loadTargets();
  const stats = {
    target: targets.length,
    fetched: 0,
    updated: 0,
    would_update: 0,
    skipped: 0,
    failed: 0,
  };

  console.log(`[MerchandiseSubtotalBackfill] target=${targets.length}`);

  for (const order of targets) {
    try {
      const accessToken = await getOrRefreshShopToken(order.shop_id);
      if (!accessToken) {
        stats.skipped++;
        console.log(`[MerchandiseSubtotalBackfill] SKIP_NO_TOKEN order_sn=${order.order_sn} shop_id=${order.shop_id} status=${order.order_status}`);
        continue;
      }

      const escrow = await getEscrowDetail(order.shop_id, order.order_sn, accessToken);
      if (!escrow) {
        stats.skipped++;
        console.log(`[MerchandiseSubtotalBackfill] SKIP_NO_ESCROW order_sn=${order.order_sn} shop_id=${order.shop_id} status=${order.order_status}`);
        continue;
      }

      stats.fetched++;
      const subtotal = parseSubtotal(escrow);
      if (!subtotal) {
        stats.skipped++;
        console.log(`[MerchandiseSubtotalBackfill] SKIP_NO_SUBTOTAL order_sn=${order.order_sn} shop_id=${order.shop_id} status=${order.order_status}`);
        continue;
      }

      if (APPLY) {
        const affectedRows = await updateSubtotal(order, subtotal);
        if (affectedRows > 0) {
          stats.updated++;
          console.log(`[MerchandiseSubtotalBackfill] UPDATE order_sn=${order.order_sn} shop_id=${order.shop_id} status=${order.order_status} subtotal=${subtotal}`);
        } else {
          stats.skipped++;
          console.log(`[MerchandiseSubtotalBackfill] SKIP_NOT_UPDATED order_sn=${order.order_sn} shop_id=${order.shop_id} status=${order.order_status} subtotal=${subtotal}`);
        }
      } else {
        stats.would_update++;
        console.log(`[MerchandiseSubtotalBackfill] DRY_RUN_UPDATE order_sn=${order.order_sn} shop_id=${order.shop_id} status=${order.order_status} subtotal=${subtotal}`);
      }
    } catch (err) {
      stats.failed++;
      console.log(`[MerchandiseSubtotalBackfill] SKIP_ERROR order_sn=${order.order_sn} shop_id=${order.shop_id} status=${order.order_status} error="${err.message}"`);
    }
  }

  console.log(`[MerchandiseSubtotalBackfill] DONE target=${stats.target} fetched=${stats.fetched} updated=${stats.updated} would_update=${stats.would_update} skipped=${stats.skipped} failed=${stats.failed}`);

  await db.end();
}

main().catch(async err => {
  console.error(`[MerchandiseSubtotalBackfill] FATAL error="${err.message}"`);
  try {
    await db.end();
  } catch (_) {}
  process.exit(1);
});
