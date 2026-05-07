/**
 * 토큰 자동 갱신 Cron Job
 * - 3시간 주기 실행
 * - access_token 만료 1시간 전 선제 갱신
 * - refresh_token 만료 5일 전 경고
 * - 실패 시 3회 재시도 (5분 간격)
 *
 * 텔레그램 중복 방지:
 *   - notifiedRefreshFail : 갱신 실패 알림을 이미 보냈으면 true → 추가 발송 안 함
 *   - notifiedExpired     : 만료 알림을 이미 보냈으면 true → 추가 발송 안 함
 *   - 갱신 성공 시 두 플래그 모두 false로 리셋
 */

const cron = require('node-cron');
const { refreshAllShopTokens, getMainAccount } = require('../services/shopeeAuth');
const { CURRENT_TENANT_ID } = require('../config/tenant');
const {
  notifyTokenRefreshFailed,
  notifyTokenExpired,
} = require('../utils/telegramNotifier');

let isRunning = false;

// ── 중복 방지 플래그 ──────────────────────────────────────────────
let notifiedRefreshFail = false;
let notifiedExpired     = false;

/**
 * 토큰 갱신 작업 실행
 * - 모든 활성 shop 토큰을 shop_id별로 갱신
 */
async function runTokenRefresh() {
  if (isRunning) {
    console.log('[TokenRefreshJob] Already running, skipping...');
    return;
  }

  isRunning = true;
  console.log(`[TokenRefreshJob] Starting at ${new Date().toISOString()}`);

  try {
    const tenantId = CURRENT_TENANT_ID;

    // refresh_token 만료 여부 먼저 확인
    const account = await getMainAccount({ tenantId });
    if (!account) {
      console.warn('[TokenRefreshJob] main_account 없음 — 스킵');
      isRunning = false;
      return;
    }

    // refresh_token 만료 → 재인증 필요
    const { isExpiringSoon } = require('../services/shopeeAuth');
    if (isExpiringSoon(account.refresh_expires_at, 5 * 86400)) {
      if (!notifiedExpired) {
        await notifyTokenExpired();
        notifiedExpired     = true;
        notifiedRefreshFail = true;
        console.log('[TokenRefreshJob] refresh_token 만료 임박 — 알림 발송');
      }
      isRunning = false;
      return;
    }

    // 전체 shop 토큰 갱신
    const { success, fail } = await refreshAllShopTokens({ tenantId });
    console.log(`[TokenRefreshJob] 완료: 성공=${success}, 실패=${fail}`);

    if (fail > 0 && success === 0) {
      // 전부 실패
      if (!notifiedRefreshFail) {
        await notifyTokenRefreshFailed();
        notifiedRefreshFail = true;
        console.log('[TokenRefreshJob] 갱신 실패 알림 발송 (이후 중복 억제)');
      }
    } else {
      // 일부라도 성공 → 플래그 리셋
      if (notifiedRefreshFail || notifiedExpired) {
        notifiedRefreshFail = false;
        notifiedExpired     = false;
        console.log('[TokenRefreshJob] 갱신 성공 — 알림 플래그 리셋');
      }
    }

  } catch (err) {
    console.error('[TokenRefreshJob] Unexpected error:', err.message);
    if (!notifiedRefreshFail) {
      await notifyTokenRefreshFailed();
      notifiedRefreshFail = true;
    }
  } finally {
    isRunning = false;
  }
}

/**
 * Cron Job 시작
 * 매 3시간 (0분에 실행): every 3 hours
 */
function startTokenRefreshJob() {
  // 서버 시작 시 즉시 1회 실행
  setTimeout(() => {
    console.log('[TokenRefreshJob] Initial token check...');
    runTokenRefresh();
  }, 5000); // 5초 후 최초 실행 (DB 연결 안정화 대기)

  // 3시간마다 실행
  cron.schedule('0 */3 * * *', () => {
    console.log('[TokenRefreshJob] Cron triggered');
    runTokenRefresh();
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  console.log('✅ Token refresh job scheduled (every 3 hours)');
}

module.exports = { startTokenRefreshJob, runTokenRefresh };
