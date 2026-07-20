const assert = require('assert');
const {
  calculateAvailableBalance,
  summarizePaymentBalances,
} = require('../src/services/paymentBalanceService');

const available = calculateAvailableBalance([
  { status: 'Payment initiated', currency: 'SGD', to_release_amount: 10.25 },
  { status: 'Processing', currency: 'SGD', to_release_amount: 99 },
  { status: 'Payment initiated', currency: 'SGD', to_release_amount: 2.75 },
], 'SGD');
assert.deepStrictEqual(available, { currency: 'SGD', balanceAmount: 13, itemCount: 2 });

const twAvailable = calculateAvailableBalance([
  { status: '撥款進行中', currency: 'TWD', to_release_amount: 265 },
  { status: 'Processing', currency: 'TWD', to_release_amount: 1000 },
], 'TWD');
assert.deepStrictEqual(twAvailable, { currency: 'TWD', balanceAmount: 265, itemCount: 1 });

const summary = summarizePaymentBalances([
  { shop_id: 1, currency: 'SGD', balance_amount: 10 },
  { shop_id: 2, currency: 'MYR', balance_amount: 100 },
], [
  { currency: 'SGD', rate_to_krw: 1100 },
  { currency: 'MYR', rate_to_krw: 360 },
  { currency: 'USD', rate_to_krw: 1400 },
]);
assert.strictEqual(summary.totals.usd_amount, (10 * 1100 + 100 * 360) / 1400);
assert.strictEqual(summary.totals.krw_amount, 47000);
assert.strictEqual(summary.totals.by_currency.length, 2);

const missingUsd = summarizePaymentBalances(
  [{ shop_id: 1, currency: 'SGD', balance_amount: 10 }],
  [{ currency: 'SGD', rate_to_krw: 1100 }]
);
assert.strictEqual(missingUsd.totals.usd_amount, null);
assert.deepStrictEqual(missingUsd.totals.missing_rates, ['USD']);

console.log('paymentBalanceService tests passed');
