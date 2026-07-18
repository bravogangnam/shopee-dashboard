const crypto = require('crypto');

const SUPPLEMENT_FIELDS = new Set([
  'tracking_number',
  'shipping_carrier',
  'checkout_shipping_carrier',
]);

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function compareUpdateTimes(storedValue, incomingValue) {
  const stored = Number(storedValue || 0);
  const incoming = Number(incomingValue || 0);
  return incoming > stored ? 'newer' : incoming < stored ? 'stale' : 'equal';
}

function lockName(tenantId, shopId, orderSn) {
  const digest = crypto
    .createHash('sha256')
    .update(`${tenantId}:${shopId}:${orderSn}`)
    .digest('hex')
    .slice(0, 48);
  return `shopee_order:${digest}`;
}

function buildGuardedSnapshotDiff(existing, incoming, fullDiff) {
  const relation = compareUpdateTimes(existing.update_time, incoming.update_time);
  let diff = {};

  if (relation === 'newer') {
    diff = { ...fullDiff };
  } else if (relation === 'equal') {
    for (const [field, value] of Object.entries(fullDiff)) {
      if (field === 'display_status' || field === 'display_status_reason') {
        diff[field] = value;
      } else if (isBlank(existing[field]) && !isBlank(value)) {
        diff[field] = value;
      }
    }
  }

  if (existing.display_status === 'TO_RETURN') {
    delete diff.display_status;
    delete diff.display_status_reason;
  }

  if (relation !== 'newer') {
    for (const field of SUPPLEMENT_FIELDS) delete diff[field];
  }

  if (
    (Object.prototype.hasOwnProperty.call(diff, 'display_status') ||
      Object.prototype.hasOwnProperty.call(diff, 'display_status_reason')) &&
    incoming.display_status_checked_at
  ) {
    diff.display_status_checked_at = incoming.display_status_checked_at;
  }

  return { relation, diff };
}

function orderItemIdentity(item) {
  const itemId = item.item_id === null || item.item_id === undefined ? '' : String(item.item_id);
  const modelId = item.model_id === null || item.model_id === undefined ? '' : String(item.model_id);
  const sku = String(item.model_sku || item.item_sku || '').trim();
  if (itemId || modelId) return `id:${itemId}::${modelId}`;
  return `sku:${sku}`;
}

function findMissingOrderItems(existingRows, incomingRows) {
  const existingKeys = new Set(existingRows.map(orderItemIdentity));
  const seenIncoming = new Set();
  return incomingRows.filter(item => {
    const identity = orderItemIdentity(item);
    if (existingKeys.has(identity) || seenIncoming.has(identity)) return false;
    seenIncoming.add(identity);
    return true;
  });
}

module.exports = {
  buildGuardedSnapshotDiff,
  compareUpdateTimes,
  findMissingOrderItems,
  lockName,
  orderItemIdentity,
};
