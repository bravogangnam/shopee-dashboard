/**
 * 백필 Worker
 * - 2026-01-01 ~ 현재까지 15일 윈도우 슬라이딩
 * - 활성 샵(is_active=1)만 대상
 * - 실패 시 마지막 성공 윈도우 이후부터 재개
 * - Job Manager 통해 진행률 업데이트
 */

const db = require('../config/database');
const { CURRENT_TENANT_ID } = require('../config/tenant');
const { getOrRefreshShopToken } = require('../services/shopeeAuth');
const {
  getOrderList,
  getOrderDetail,
  getEscrowDetail,
  mapOrderToDb,
} = require('../services/shopeeOrder');
const {
  batchInsertOrders,
  batchInsertOrderItems,
  filterNewOrderSns,
  logSync,
  getLastSuccessfulBackfillEnd,
} = require('../services/orderDb');
const {
  startJob,
  updateProgress,
  completeJob,
  failJob,
} = require('../services/jobManager');
const { sleep } = require('../utils/apiWrapper');

const BACKFILL_START = new Date('2026-01-01T00:00:00+09:00'); // KST 기준
const WINDOW_DAYS = 15;
const WINDOW_DELAY_MS = 3000; // 윈도우 간 3초 딜레이

/**
 * 15일 윈도우 목록 생성
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {{ from: Date, to: Date }[]}
 */
function buildWindows(startDate, endDate) {
  const windows = [];
  let cur = new Date(startDate);
  while (cur < endDate) {
    const next = new Date(cur);
    next.setDate(next.getDate() + WINDOW_DAYS);
    windows.push({
      from: new Date(cur),
      to: next > endDate ? new Date(endDate) : new Date(next),
    });
    cur = next;
  }
  return windows;
}

/**
 * 단일 윈도우 × 단일 샵 처리
 */
async function processWindow(shop, window, accessToken) {
  const timeFrom = Math.floor(window.from.getTime() / 1000);
  const timeTo = Math.floor(window.to.getTime() / 1000);

  let fetched = 0;
  let inserted = 0;

  try {
    // 1. order_sn 목록 수집
    const allSns = await getOrderList(shop.shop_id, timeFrom, timeTo, accessToken);
    fetched = allSns.length;

    if (allSns.length === 0) {
      await logSync(shop.shop_id, 'backfill', window.from, window.to, 0, 0, 'success', null);
      return { fetched: 0, inserted: 0 };
    }

    // 2. DB에 없는 order_sn만 필터
    const newSns = await filterNewOrderSns(shop.shop_id, allSns);
    if (newSns.length === 0) {
      await logSync(shop.shop_id, 'backfill', window.from, window.to, fetched, 0, 'success', null);
      return { fetched, inserted: 0 };
    }

    // 3. get_order_detail (50건 배치)
    const orderDetails = await getOrderDetail(shop.shop_id, newSns, accessToken);

    // 4. escrow_detail + DB 저장
    const orderRows = [];
    const itemRowsAll = [];

    for (const order of orderDetails) {
      let escrow = null;
      // escrow 조회는 완료된 주문 또는 수수료 필드가 없을 때만
      if (['COMPLETED', 'SHIPPED', 'PROCESSED'].includes(order.order_status)) {
        try {
          escrow = await getEscrowDetail(shop.shop_id, order.order_sn, accessToken);
          await sleep(200); // escrow 호출 간 딜레이
        } catch (e) {
          // 수수료 조회 실패는 스킵
        }
      }

      const { orderRow, itemRows } = mapOrderToDb(order, shop.shop_id, shop.region, escrow);
      orderRows.push(orderRow);
      itemRowsAll.push(...itemRows);
    }

    const { inserted: ins } = await batchInsertOrders(orderRows);
    await batchInsertOrderItems(itemRowsAll);
    inserted = ins;

    await logSync(shop.shop_id, 'backfill', window.from, window.to, fetched, inserted, 'success', null);
    return { fetched, inserted };
  } catch (err) {
    await logSync(shop.shop_id, 'backfill', window.from, window.to, fetched, 0, 'fail', err.message);
    throw err;
  }
}

/**
 * 백필 메인 실행 함수
 * @param {string} jobId
 */
async function runBackfill(jobId, { tenantId = CURRENT_TENANT_ID } = {}) {
  try {
    // 활성 샵 목록
    const [shops] = await db.query(
      'SELECT shop_id, alias, region FROM shops WHERE tenant_id = ? AND is_active = 1 ORDER BY id ASC',
      [tenantId]
    );
    if (!shops.length) {
      await failJob(jobId, '활성화된 샵이 없습니다');
      return;
    }

    const now = new Date();

    // 전체 윈도우 계산 (샵별로 독립적으로 재개)
    // 전체 진행률 = 샵 × 윈도우 수
    const allWindows = buildWindows(BACKFILL_START, now);
    const totalSteps = shops.length * allWindows.length;

    await startJob(jobId, totalSteps);

    let globalStep = 0;
    let totalFetched = 0;
    let totalInserted = 0;
    const shopResults = [];

    for (const shop of shops) {
      // 마지막 성공 윈도우 확인 → 재개 지점 결정
      const lastEnd = await getLastSuccessfulBackfillEnd(shop.shop_id);
      const resumeFrom = lastEnd ? new Date(lastEnd) : BACKFILL_START;
      const shopWindows = buildWindows(resumeFrom, now);

      let shopFetched = 0;
      let shopInserted = 0;
      let shopFailed = 0;

      for (let wi = 0; wi < shopWindows.length; wi++) {
        const win = shopWindows[wi];
        globalStep++;

        const msg = `[${shop.alias || shop.shop_id}] ${win.from.toISOString().slice(0,10)} ~ ${win.to.toISOString().slice(0,10)} (${globalStep}/${totalSteps})`;
        await updateProgress(jobId, globalStep, totalSteps, msg);

        try {
          // 윈도우마다 shop 토큰 최신 조회 (만료 시 자동 갱신)
          const shopAccessToken = await getOrRefreshShopToken(shop.shop_id);
          if (!shopAccessToken) {
            throw new Error(`shop_id=${shop.shop_id} 토큰 없음 — OAuth 재인증 필요`);
          }
          const { fetched, inserted } = await processWindow(shop, win, shopAccessToken);
          shopFetched += fetched;
          shopInserted += inserted;
          totalFetched += fetched;
          totalInserted += inserted;
        } catch (err) {
          shopFailed++;
          console.error(`[Backfill] Failed window ${msg}: ${err.message}`);
          // 윈도우 하나 실패해도 다음 윈도우 계속
        }

        // 윈도우 간 딜레이 (마지막 윈도우 제외)
        if (wi < shopWindows.length - 1) {
          await sleep(WINDOW_DELAY_MS);
        }
      }

      shopResults.push({
        shop_id: shop.shop_id,
        alias: shop.alias,
        region: shop.region,
        fetched: shopFetched,
        inserted: shopInserted,
        failed_windows: shopFailed,
      });
    }

    await completeJob(jobId, {
      total_fetched: totalFetched,
      total_inserted: totalInserted,
      shops: shopResults,
    });

    console.log(`[Backfill] Done: fetched=${totalFetched}, inserted=${totalInserted}`);
  } catch (err) {
    console.error('[Backfill] Fatal error:', err.message);
    await failJob(jobId, err.message);
  }
}

module.exports = { runBackfill };
