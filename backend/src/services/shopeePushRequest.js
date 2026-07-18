const OPERATIONAL_PUSH_CODES = new Set([3, 4, 15]);

function classifyPushRequest(payload) {
  const shopId = Number(payload?.shop_id);
  const code = Number(payload?.code);
  if (!shopId || !OPERATIONAL_PUSH_CODES.has(code)) {
    return { type: 'verification', shopId, code };
  }
  return { type: 'operational', shopId, code };
}

module.exports = { OPERATIONAL_PUSH_CODES, classifyPushRequest };
