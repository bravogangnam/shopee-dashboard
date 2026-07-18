/**
 * 텔레그램 알림 유틸리티
 *
 * 환경변수:
 *   TELEGRAM_BOT_TOKEN  - 봇 토큰 (8302293113:AAE...)
 *   TELEGRAM_CHAT_ID    - 채팅방 ID (8338237304)
 *
 * 사용처:
 *   - tokenRefreshJob: 토큰 갱신 실패 / 토큰 완전 만료
 *   - autoSyncJob: 동기화 실패 / 새 주문 감지
 */

const axios = require('axios');
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * 텔레그램 메시지 전송 (내부 공통 함수)
 * @param {string} text - 전송할 메시지 (Markdown 지원)
 */
async function sendMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 미설정 — 알림 스킵');
    return { skipped: true, reason: 'missing_telegram_env' };
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text,
        parse_mode: 'Markdown',
      },
      { timeout: 10000 }
    );
    console.log(`[Telegram] ✅ 메시지 전송 완료: ${text.slice(0, 60)}...`);
    return { sent: true };
  } catch (err) {
    // 텔레그램 전송 실패는 로그만 남기고 서버 크래시 없음
    console.error(`[Telegram] ❌ 전송 실패: ${err.message}`);
    return { failed: true, reason: err.message };
  }
}

// ── 알림 종류별 함수 ─────────────────────────────────────────────

/**
 * 토큰 갱신 실패 알림
 */
async function notifyTokenRefreshFailed() {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await sendMessage(
    `⚠️ *[Shopee] 토큰 갱신 실패*\n` +
    `재인증이 필요합니다.\n` +
    `🕐 ${now} UTC`
  );
}

/**
 * 토큰 완전 만료 알림 (refresh_token 포함)
 */
async function notifyTokenExpired() {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await sendMessage(
    `🚨 *[Shopee] 토큰 완전 만료*\n` +
    `즉시 재인증이 필요합니다.\n` +
    `대시보드 접속 후 설정에서 재인증하세요.\n` +
    `🕐 ${now} UTC`
  );
}

/**
 * 동기화 실패 알림
 * @param {string} errorMessage
 */
async function notifySyncFailed(errorMessage) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const shortErr = (errorMessage || '알 수 없는 오류').slice(0, 200);
  await sendMessage(
    `❌ *[Shopee] 동기화 실패*\n` +
    `에러: \`${shortErr}\`\n` +
    `🕐 ${now} UTC`
  );
}

/**
 * 새 주문 감지 알림
 * @param {number} total      - 전체 새 주문 수
 * @param {object} byRegion   - { SG: n, MY: n, PH: n, TW: n } 형태
 */
function escapeMarkdownText(value) {
  return String(value || '-')
    .replace(/([_*`\[\]])/g, '\\$1')
    .slice(0, 180);
}

function formatNewOrderProductLine(item) {
  const productName = escapeMarkdownText(item.productName || item.sku || '-');
  const optionName = String(item.optionName || '').trim();
  const qty = Number(item.qty || 1);
  const optionText = optionName && optionName !== '-' ? ` / ${escapeMarkdownText(optionName)}` : '';
  const unitPrice = item.unitPrice === null || item.unitPrice === undefined || item.unitPrice === ''
    ? NaN
    : Number(item.unitPrice);
  const currency = escapeMarkdownText(item.currency || '');
  const priceText = Number.isFinite(unitPrice)
    ? ` / 판매가: ${unitPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`
    : ' / 판매가: -';

  return `  상품명: ${productName}\n` +
    `  옵션명: ${optionText ? escapeMarkdownText(optionName) : '-'}\n` +
    `  수량: ${Number.isFinite(qty) ? qty : 1}개\n` +
    `  ${priceText.slice(3)}`;
}

function groupNewOrderItemsByOrder(items = []) {
  const groups = [];
  const groupMap = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const region = item.region || '-';
    const orderSn = item.orderSn || '-';
    const key = `${region}::${orderSn}`;

    if (!groupMap.has(key)) {
      const group = {
        region,
        orderSn,
        items: [],
      };
      groupMap.set(key, group);
      groups.push(group);
    }

    groupMap.get(key).items.push(item);
  }

  return groups;
}

function formatNewOrderGroup(group) {
  const region = escapeMarkdownText(group.region || '-');
  const orderSn = escapeMarkdownText(group.orderSn || '-');
  const productLines = group.items.map(formatNewOrderProductLine);

  return [
    `- ${region} ${orderSn}`,
    ...productLines,
  ].join('\n');
}

async function notifyNewOrders(total, byRegion = {}, items = []) {
  if (total <= 0) return; // 새 주문 없으면 스킵

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // 지역별 내역 — SG, MY, PH, TW 순서로 고정 (0건 지역은 생략)
  const REGION_ORDER = ['SG', 'MY', 'PH', 'TW'];
  const regionParts = REGION_ORDER
    .filter(r => (byRegion[r] || 0) > 0)
    .map(r => `${r}: ${byRegion[r]}건`)
    .join(', ');

  const detail = regionParts ? ` (${regionParts})` : '';
  const groupedOrders = groupNewOrderItemsByOrder(items);

  const headerLines = [
    `🛍️ *[Shopee 신규 주문] ${total}건*${detail}`,
    `🕐 ${now} UTC`,
  ];

  if (!groupedOrders.length) {
    return sendMessage(headerLines.join('\n'));
  }

  const MAX_MESSAGE_LENGTH = 3500;
  const messages = [];
  let currentLines = [
    ...headerLines,
    '',
    '*주문 상품 상세*',
  ];

  for (const group of groupedOrders) {
    const groupText = formatNewOrderGroup(group);
    const nextText = [...currentLines, groupText].join('\n');

    if (nextText.length > MAX_MESSAGE_LENGTH && currentLines.length > 3) {
      messages.push(currentLines.join('\n'));
      currentLines = [
        `🛍️ *[Shopee 신규 주문] ${total}건*${detail} \(계속\)`,
        `🕐 ${now} UTC`,
        '',
        '*주문 상품 상세*',
        groupText,
      ];
    } else {
      currentLines.push(groupText);
    }
  }

  if (currentLines.length > 3) {
    messages.push(currentLines.join('\n'));
  }

  const results = [];
  for (const message of messages) results.push(await sendMessage(message));
  return results.find(result => result?.failed) ||
    (results.some(result => result?.sent) ? { sent: true } : results[0]);
}

function resolveUnitPrice(discountedPrice, originalPrice) {
  const discounted = Number(discountedPrice);
  if (discountedPrice !== null && discountedPrice !== '' && Number.isFinite(discounted) && discounted > 0) {
    return discounted;
  }
  const original = Number(originalPrice);
  return originalPrice !== null && originalPrice !== '' && Number.isFinite(original)
    ? original
    : null;
}

module.exports = {
  notifyTokenRefreshFailed,
  notifyTokenExpired,
  notifySyncFailed,
  notifyNewOrders,
  formatNewOrderProductLine,
  resolveUnitPrice,
};
