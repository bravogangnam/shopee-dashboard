const assert = require('assert');
const {
  calculateDiscoveryRange,
  buildOrderListWindows,
} = require('../src/jobs/orderDiscoveryRange');

function run() {
  const now = 2_000_000_000;
  const hour = 60 * 60;
  const day = 24 * hour;

  assert.deepStrictEqual(
    calculateDiscoveryRange(now - hour, now),
    { timeFrom: now - (6 * hour), timeTo: now },
    'normal synchronization must always overlap the last six hours'
  );

  const delayedFiveHoursAgo = now - (5 * hour);
  const overlap = calculateDiscoveryRange(now - hour, now);
  assert.ok(delayedFiveHoursAgo >= overlap.timeFrom, 'a five-hour delayed order must be re-read');

  assert.deepStrictEqual(
    calculateDiscoveryRange(null, now),
    { timeFrom: now - (30 * day), timeTo: now },
    'the initial synchronization must retain the 30-day range'
  );

  assert.deepStrictEqual(
    calculateDiscoveryRange(now - hour, now, 'reconciliation'),
    { timeFrom: now - (3 * day), timeTo: now },
    'reconciliation must re-read the last three days'
  );

  const windows = buildOrderListWindows(now - (30 * day), now);
  assert.strictEqual(windows.length, 3, 'a 30-day range must be split at the 15-day API limit');
  assert.ok(windows.every(window => window.to - window.from + 1 <= 15 * day));
  assert.strictEqual(windows[0].from, now - (30 * day));
  assert.strictEqual(windows.at(-1).to, now);
  for (let i = 1; i < windows.length; i += 1) {
    assert.strictEqual(windows[i].from, windows[i - 1].to + 1, 'windows must not overlap or leave gaps');
  }

  const existing = new Set(['ORDER-1']);
  const discovered = ['ORDER-1', 'ORDER-2', 'ORDER-1'];
  const newOrders = [...new Set(discovered)].filter(orderSn => !existing.has(orderSn));
  assert.deepStrictEqual(newOrders, ['ORDER-2'], 'overlap/reconciliation re-reads must only retain missing orders');

  console.log('order discovery overlap and reconciliation tests passed');
}

run();
