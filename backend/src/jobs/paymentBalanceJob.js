/**
 * Shopee Payment Balance auto refresh
 *
 * Keeps payout balance and weekly payout forecast data fresh even when the
 * ledger page is not open.  Uses the same refresh path as the manual button so
 * the saved Balance Amount and Payment initiated income items stay consistent.
 */

const cron = require('node-cron');
const { CURRENT_TENANT_ID } = require('../config/tenant');
const { refreshPaymentBalances } = require('../services/paymentBalanceService');

let isRunning = false;
let lastRunAt = null;
let lastResult = null;

async function runPaymentBalanceRefresh({ source = 'cron' } = {}) {
  if (isRunning) {
    console.log('[PaymentBalanceJob] skip: previous refresh is still running');
    return { skipped: true };
  }

  isRunning = true;
  lastRunAt = new Date();
  try {
    const tenantId = CURRENT_TENANT_ID;
    console.log(`[PaymentBalanceJob] start source=${source} tenant_id=${tenantId} at=${lastRunAt.toISOString()}`);
    const results = await refreshPaymentBalances(tenantId);
    lastResult = {
      success: true,
      total: results.length,
      succeeded: results.filter((result) => result.success).length,
      failed: results.filter((result) => !result.success).length,
    };
    console.log(`[PaymentBalanceJob] done total=${lastResult.total} succeeded=${lastResult.succeeded} failed=${lastResult.failed}`);
    return lastResult;
  } catch (err) {
    lastResult = { success: false, error: err.message };
    console.error(`[PaymentBalanceJob] failed: ${err.message}`);
    return lastResult;
  } finally {
    isRunning = false;
  }
}

function startPaymentBalanceJob() {
  setTimeout(() => {
    runPaymentBalanceRefresh({ source: 'startup' });
  }, 90 * 1000);

  cron.schedule('*/5 * * * *', () => {
    runPaymentBalanceRefresh({ source: 'cron' });
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  console.log('✅ Payment balance refresh job scheduled (every 5 minutes)');
}

function getPaymentBalanceJobStatus() {
  return {
    isRunning,
    lastRunAt,
    lastResult,
  };
}

module.exports = {
  getPaymentBalanceJobStatus,
  runPaymentBalanceRefresh,
  startPaymentBalanceJob,
};
