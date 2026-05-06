function isPurchaseAlertEnabled() {
  return String(process.env.PURCHASE_ALERT_ENABLED || '').trim() === 'true';
}

function formatKrw(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return `₩${Math.round(number).toLocaleString('ko-KR')}`;
}

function buildPurchaseNeededMessage({
  sku,
  productName,
  shortageQty,
  currentStock,
  unitCostVatIncluded,
  orderSn,
}) {
  const lines = [
    '[구매필요 발생]',
    '',
    `SKU: ${sku}`,
    `상품명: ${productName || sku}`,
    `구매필요 수량: ${Number(shortageQty || 0).toLocaleString('ko-KR')}개`,
    `현재 재고: ${Number(currentStock || 0).toLocaleString('ko-KR')}`,
    `주문번호: ${orderSn || '-'}`,
  ];

  const formattedUnitCost = formatKrw(unitCostVatIncluded);
  if (formattedUnitCost) {
    const estimatedAmount = Number(shortageQty || 0) * Number(unitCostVatIncluded || 0);
    lines.push(`예상 단가: ${formattedUnitCost}`);
    lines.push(`예상 구매액: ${formatKrw(estimatedAmount)}`);
  }

  return lines.join('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendTelegramAlert({ text, imageUrl }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { skipped: true, reason: 'missing_telegram_env' };
  }

  const endpoint = imageUrl ? 'sendPhoto' : 'sendMessage';
  const body = imageUrl
    ? { chat_id: chatId, photo: imageUrl, caption: text }
    : { chat_id: chatId, text };

  async function sendOnce() {
    return fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  let response = await sendOnce();

  if (response.status === 429) {
    const message = await response.text().catch(() => '');
    let retryAfter = 10;

    try {
      const parsed = JSON.parse(message);
      retryAfter = Number(parsed?.parameters?.retry_after || retryAfter);
    } catch (err) {
      // keep default retryAfter
    }

    const waitSeconds = Math.min(Math.max(retryAfter + 1, 3), 30);
    console.warn(`[PurchaseAlert] Telegram rate limited. retry_after=${retryAfter}s, waiting=${waitSeconds}s`);
    await sleep(waitSeconds * 1000);

    response = await sendOnce();
  }

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Telegram alert failed: ${response.status} ${message}`);
  }

  return { sent: true, channel: 'telegram' };
}

async function notifyPurchaseNeeded(payload) {
  if (!isPurchaseAlertEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }

  const channel = process.env.PURCHASE_ALERT_CHANNEL || 'telegram';
  if (channel !== 'telegram') {
    return { skipped: true, reason: `unsupported_channel:${channel}` };
  }

  // TODO: purchase_alert_logs 테이블로 SKU/order별 중복 알림 방지
  const text = buildPurchaseNeededMessage(payload);
  try {
    return await sendTelegramAlert({ text, imageUrl: payload.imageUrl });
  } catch (err) {
    console.warn(`[PurchaseAlert] ${err.message}`);
    return { failed: true, reason: err.message };
  }
}

module.exports = {
  buildPurchaseNeededMessage,
  isPurchaseAlertEnabled,
  notifyPurchaseNeeded,
};
