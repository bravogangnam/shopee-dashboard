/**
 * 자동 동기화 Cron Job
 *
 * - 5분 주기 실행 (node-cron)
 * - 동기화 중복 실행 방지: isRunning lock
 * - 이전 동기화가 진행 중이면 즉시 스킵 (로그 출력)
 * - jobManager를 통해 job 생성 → syncWorker.runSync() 호출
 * - 에러는 catch 후 로그만 남기고 서버 크래시 없음
 * - 텔레그램 알림: 동기화 실패 / 새 주문 감지
 *
 * 텔레그램 중복 방지:
 *   - notifiedSyncFail : 동기화 실패 알림을 이미 보냈으면 true → 추가 발송 안 함
 *   - 동기화 성공 시 플래그 false로 리셋 → 다음 에러 때 다시 알림 가능
 */

const cron = require('node-cron');
const {
  createJob,
  getRunningJob,
  markStaleJobsFailed,
} = require('../services/jobManager');
const { CURRENT_TENANT_ID }    = require('../config/tenant');
const { runSync, runReconciliation } = require('./syncWorker');
const {
  notifySyncFailed,
  notifyNewOrders,
} = require('../utils/telegramNotifier');

// ── Lock: 동시 실행 방지 ────────────────────────────────────────
let isRunning = false;
let lastRunAt = null;
let lastResult = null; // { success, new_orders, updated_orders, error }

// ── 중복 방지 플래그 ────────────────────────────────────────────
let notifiedSyncFail = false; // 동기화 실패 알림 발송 여부

/**
 * 자동 동기화 1회 실행
 */
async function runAutoSync({ reconciliation = false } = {}) {
  if (isRunning) {
    console.log('[AutoSync] ⏭ 이전 동기화 진행 중 — 스킵');
    return;
  }

  isRunning = true;
  lastRunAt = new Date();
  console.log(`[AutoSync] ▶ 자동 동기화 시작  ${lastRunAt.toISOString()}`);

  try {
    const tenantId = CURRENT_TENANT_ID;

    // 서버 재시작/배포 직후에도 DB 기준 running sync가 있으면 새 sync 생성 방지
    await markStaleJobsFailed({ tenantId });
    const running = await getRunningJob('sync', { tenantId });
    if (running) {
      console.log(`[AutoSync] ⏭ DB상 sync 진행 중 — 스킵 jobId=${running.id}`);
      lastResult = { success: true, skipped: true, running_job_id: running.id };
      return;
    }

    // jobManager를 통해 job 생성 (type: 'sync' — DB enum에 정의된 값 사용)
    const jobId = await createJob('sync', { tenantId });

    // syncWorker 실행 → { new_orders, new_orders_by_region } 반환
    const result = reconciliation
      ? await runReconciliation(jobId, { tenantId })
      : await runSync(jobId, { tenantId });

      const newOrders   = result?.new_orders          || 0;
      const readyToShipNewOrders = result?.ready_to_ship_new_orders || 0;
      const byRegion    = result?.ready_to_ship_new_orders_by_region || {};
      const readyToShipNewOrderItems = Array.isArray(result?.ready_to_ship_new_order_items)
        ? result.ready_to_ship_new_order_items
        : [];

      lastResult = {
        success: true,
        new_orders: newOrders,
        ready_to_ship_new_orders: readyToShipNewOrders,
        ready_to_ship_new_order_items: readyToShipNewOrderItems.length,
      };
      console.log(`[AutoSync] ✅ 완료  jobId=${jobId}  new=${newOrders}  ready_to_ship_alert=${readyToShipNewOrders}`);

    // 동기화 성공 → 실패 플래그 리셋 (다음 에러 때 다시 알림 가능)
    if (notifiedSyncFail) {
      notifiedSyncFail = false;
      console.log('[AutoSync] 동기화 성공 — 실패 알림 플래그 리셋');
    }

      // 새 주문 알림은 READY_TO_SHIP 대상만 발송한다. UNPAID 신규 주문은 제외.
      if (readyToShipNewOrders > 0) {
        await notifyNewOrders(readyToShipNewOrders, byRegion, readyToShipNewOrderItems);
    }

  } catch (err) {
    lastResult = { success: false, error: err.message };
    console.error(`[AutoSync] ❌ 오류: ${err.message}`);

    // 동기화 실패 텔레그램 알림 — 최초 1회만 발송
    if (!notifiedSyncFail) {
      await notifySyncFailed(err.message);
      notifiedSyncFail = true;
      console.log('[AutoSync] 동기화 실패 알림 발송 완료 (이후 중복 억제)');
    } else {
      console.log('[AutoSync] 동기화 실패 알림 이미 발송됨 — 스킵');
    }
  } finally {
    isRunning = false;
  }
}

/**
 * 자동 동기화 Cron 시작
 * - 매 5분마다 실행
 * - 서버 시작 후 60초 뒤 초기 1회 실행 (DB/토큰 안정화 대기)
 */
function startAutoSyncJob() {
  // 서버 시작 후 60초 뒤 첫 실행
  setTimeout(() => {
    console.log('[AutoSync] 초기 자동 동기화 실행...');
    runAutoSync();
  }, 60 * 1000);

  // 5분마다 실행
  cron.schedule('*/5 * * * *', () => {
    console.log('[AutoSync] ⏰ Cron 트리거');
    runAutoSync();
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  // Re-scan the last three days every six hours. The shared in-process and DB
  // job locks prevent this from overlapping the regular synchronization.
  cron.schedule('2 */6 * * *', () => {
    console.log('[AutoSync] Reconciliation cron trigger (3-day create_time window)');
    runAutoSync({ reconciliation: true });
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  console.log('✅ Auto sync job scheduled (every 5 minutes)');
}

/**
 * 현재 상태 조회 (디버깅/모니터링용)
 */
function getAutoSyncStatus() {
  return {
    isRunning,
    lastRunAt,
    lastResult,
  };
}

module.exports = { startAutoSyncJob, runAutoSync, getAutoSyncStatus };
