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
    return;
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
  } catch (err) {
    // 텔레그램 전송 실패는 로그만 남기고 서버 크래시 없음
    console.error(`[Telegram] ❌ 전송 실패: ${err.message}`);
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

  return `  ${productName}${optionText} x ${Number.isFinite(qty) ? qty : 1}`;
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
  const visibleGroups = groupedOrders.slice(0, 10);
  const hiddenOrderCount = Math.max(0, groupedOrders.length - visibleGroups.length);
  const visibleItemCount = visibleGroups.reduce((sum, group) => sum + group.items.length, 0);
  const totalItemCount = groupedOrders.reduce((sum, group) => sum + group.items.length, 0);
  const hiddenItemCount = Math.max(0, totalItemCount - visibleItemCount);

  const lines = [
    `🛍️ *[Shopee] 새 주문 ${total}건*${detail}`,
    `🕐 ${now} UTC`,
  ];

  if (visibleGroups.length) {
    lines.push('');
    lines.push('*상품명*');
    lines.push(...visibleGroups.map(formatNewOrderGroup));
    if (hiddenOrderCount > 0 || hiddenItemCount > 0) {
      lines.push(`외 ${hiddenOrderCount}개 주문 / ${hiddenItemCount}개 상품`);
    }
  }

  await sendMessage(lines.join('\n'));
}

module.exports = {
  notifyTokenRefreshFailed,
  notifyTokenExpired,
  notifySyncFailed,
  notifyNewOrders,
};
