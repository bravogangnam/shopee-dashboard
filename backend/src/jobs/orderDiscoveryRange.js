const NORMAL_OVERLAP_SECONDS = 6 * 60 * 60;
const RECONCILIATION_SECONDS = 3 * 24 * 60 * 60;
const INITIAL_SYNC_SECONDS = 30 * 24 * 60 * 60;
const MAX_ORDER_LIST_WINDOW_SECONDS = 15 * 24 * 60 * 60;

function calculateDiscoveryRange(latestCreateTime, now, mode = 'normal_overlap') {
  if (mode === 'reconciliation') {
    return { timeFrom: now - RECONCILIATION_SECONDS, timeTo: now };
  }

  if (!latestCreateTime) {
    return { timeFrom: now - INITIAL_SYNC_SECONDS, timeTo: now };
  }

  const watermarkFrom = Number(latestCreateTime) + 1;
  const overlapFrom = now - NORMAL_OVERLAP_SECONDS;
  return { timeFrom: Math.min(watermarkFrom, overlapFrom), timeTo: now };
}

function buildOrderListWindows(timeFrom, timeTo) {
  const windows = [];
  let cur = timeFrom;
  while (cur <= timeTo) {
    const end = Math.min(cur + MAX_ORDER_LIST_WINDOW_SECONDS - 1, timeTo);
    windows.push({ from: cur, to: end });
    cur = end + 1;
  }
  return windows;
}

module.exports = {
  calculateDiscoveryRange,
  buildOrderListWindows,
};
