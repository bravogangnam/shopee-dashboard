/**
 * 수동 동기화 Worker
 *
 * Step 1 - 신규 주문 수집:
 *   각 샵별 DB 최신 create_time → 그 이후 주문 수집 → INSERT
 *
 * Step 2 - 기존 주문 업데이트:
 *   is_final_status=0 주문 → get_order_detail → 변경 필드만 UPDATE
 *   COMPLETED/CANCELLED → is_final_status=1
 */

const db = require('../config/database');
const { getMainAccount } = require('../services/shopeeAuth');
const {
  getOrderList,
  getOrderDetail,
  getEscrowDetail,
  getTrackingNumber,
  mapOrderToDb,
  diffOrderRow,
} = require('../services/shopeeOrder');
const {
  batchInsertOrders,
  batchInsertOrderItems,
  filterNewOrderSns,
  getLatestCreateTime,
  getNonFinalOrders,
  updateOrder,
  logSync,
} = require('../services/orderDb');
const {
  startJob,
  updateProgress,
  completeJob,
  failJob,
} = require('../services/jobManager');
const { sleep } = require('../utils/apiWrapper');

// ── 타이밍 헬퍼 ─────────────────────────────────────────────────
const t = () => Date.now();
function ms(start) { return `${Date.now() - start}ms`; }

// ── escrow 병렬 조회 (CONCURRENCY건씩 동시 호출) ────────────────
const ESCROW_CONCURRENCY = 5;

async function fetchEscrowParallel(orders, shopId, accessToken, label) {
  const escrowMap = {};
  const total = orders.length;
  const escrowStart = t();

  for (let i = 0; i < total; i += ESCROW_CONCURRENCY) {
    const chunk = orders.slice(i, i + ESCROW_CONCURRENCY);
    const chunkStart = t();

    const results = await Promise.allSettled(
      chunk.map(order =>
        getEscrowDetail(shopId, order.order_sn, accessToken)
          .then(escrow => ({ order_sn: order.order_sn, escrow }))
          .catch(e => ({ order_sn: order.order_sn, escrow: null, error: e.message }))
      )
    );

    const batchIdx = Math.floor(i / ESCROW_CONCURRENCY) + 1;
    const batchTotal = Math.ceil(total / ESCROW_CONCURRENCY);
    const settled = results.map(r => r.value);

    settled.forEach(({ order_sn, escrow, error }) => {
      if (escrow) {
        escrowMap[order_sn] = escrow;
        console.log(`${label} │    escrow[${order_sn}]: OK`);
      } else {
        console.log(`${label} │    escrow[${order_sn}]: SKIP (${(error || 'null').slice(0, 50)})`);
      }
    });

    console.log(`${label} │  escrow batch[${batchIdx}/${batchTotal}] ${chunk.length}건 병렬완료: ${ms(chunkStart)}`);
  }

  console.log(`${label} │  전체 escrow 조회 완료: ${ms(escrowStart)}  (${ESCROW_CONCURRENCY}건씩 병렬)`);
  return escrowMap;
}

/**
 * 수동 동기화 메인 실행 함수
 * @param {string} jobId
 */
async function runSync(jobId) {
  const syncStart = t();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Sync] ▶ START  jobId=${jobId}  ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    const [shops] = await db.query(
      'SELECT shop_id, alias, region FROM shops WHERE is_active = 1 ORDER BY id ASC'
    );
    if (!shops.length) {
      await failJob(jobId, '활성화된 샵이 없습니다');
      return;
    }

    const account = await getMainAccount();
    if (!account?.access_token) {
      await failJob(jobId, 'Shopee access_token이 없습니다. OAuth 인증을 먼저 진행하세요.');
      return;
    }

    console.log(`[Sync] 활성 샵 ${shops.length}개: ${shops.map(s => s.alias || s.shop_id).join(', ')}`);

    // 전체 스텝: 샵 × 3 (Step1 + Step2 + Step3)
    const totalSteps = shops.length * 3;
    await startJob(jobId, totalSteps);

    let step = 0;
    let totalNewOrders = 0;
    let totalUpdated = 0;

    // ───────────────────────────────────────────────────────────
    // STEP 1: 신규 주문 수집
    // ───────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Sync] STEP 1 START — 신규 주문 수집`);
    const step1Start = t();

    for (const shop of shops) {
      step++;
      const shopAlias = shop.alias || shop.shop_id;
      const shopStart = t();

      await updateProgress(jobId, step, totalSteps,
        `[Step1] ${shopAlias} 신규 주문 수집 중...`);

      console.log(`\n[Sync][Step1] ┌─ shop=${shopAlias} (id=${shop.shop_id})`);

      try {
        // ── DB에서 최신 타임스탬프 조회 ──
        const tsStart = t();
        const latestTs = await getLatestCreateTime(shop.shop_id);
        console.log(`[Sync][Step1] │  getLatestCreateTime: ${ms(tsStart)}  → latestTs=${latestTs ? new Date(latestTs*1000).toISOString() : 'none(최초)'}`);

        const now = Math.floor(Date.now() / 1000);
        const timeFrom = latestTs ? latestTs + 1 : now - (30 * 86400);
        const timeTo = now;

        // Shopee 최대 조회 범위 15일 → 슬라이딩 윈도우
        const windows = [];
        let cur = timeFrom;
        const windowSec = 15 * 86400;
        while (cur < timeTo) {
          const end = Math.min(cur + windowSec, timeTo);
          windows.push({ from: cur, to: end });
          cur = end + 1;
        }
        console.log(`[Sync][Step1] │  시간 범위: ${new Date(timeFrom*1000).toISOString().slice(0,10)} ~ ${new Date(timeTo*1000).toISOString().slice(0,10)}  윈도우 ${windows.length}개`);

        let shopNewCount = 0;

        for (const [wi, win] of windows.entries()) {
          const winLabel = `win[${wi+1}/${windows.length}]`;

          // ── get_order_list ──
          const listStart = t();
          const allSns = await getOrderList(shop.shop_id, win.from, win.to, account.access_token);
          console.log(`[Sync][Step1] │  get_order_list ${winLabel}: ${ms(listStart)}  → ${allSns.length}건`);

          // ── filterNewOrderSns (DB 중복 체크) ──
          const filterStart = t();
          const newSns = await filterNewOrderSns(shop.shop_id, allSns);
          console.log(`[Sync][Step1] │  filterNewOrderSns ${winLabel}: ${ms(filterStart)}  → 신규 ${newSns.length}/${allSns.length}건`);

          if (newSns.length > 0) {
            // ── get_order_detail ──
            const detailStart = t();
            const details = await getOrderDetail(shop.shop_id, newSns, account.access_token);
            console.log(`[Sync][Step1] │  get_order_detail ${winLabel}: ${ms(detailStart)}  → ${details.length}건 (배치=${Math.ceil(newSns.length/50)})`);

            // ── get_escrow_detail (5건씩 병렬) ──
            const escrowNeededOrders = details.filter(o =>
              ['COMPLETED', 'SHIPPED', 'PROCESSED', 'TO_CONFIRM_RECEIVE', 'READY_TO_SHIP'].includes(o.order_status)
            );
            console.log(`[Sync][Step1] │  escrow 대상: ${escrowNeededOrders.length}/${details.length}건  (${ESCROW_CONCURRENCY}건씩 병렬)`);

            const escrowMap1 = await fetchEscrowParallel(
              escrowNeededOrders, shop.shop_id, account.access_token, '[Sync][Step1]'
            );

            const orderRows = [];
            const itemRowsAll = [];

            for (const order of details) {
              const escrow = escrowMap1[order.order_sn] || null;
              const { orderRow, itemRows } = mapOrderToDb(order, shop.shop_id, shop.region, escrow);
              orderRows.push(orderRow);
              itemRowsAll.push(...itemRows);
            }

            // ── DB INSERT ──
            const insertStart = t();
            const { inserted } = await batchInsertOrders(orderRows);
            await batchInsertOrderItems(itemRowsAll);
            console.log(`[Sync][Step1] │  batchInsert: ${ms(insertStart)}  → inserted=${inserted}`);
            shopNewCount += inserted;
          }

          if (windows.length > 1) await sleep(1000);
        }

        totalNewOrders += shopNewCount;
        await logSync(shop.shop_id, 'manual', new Date(timeFrom * 1000), new Date(timeTo * 1000),
          shopNewCount, shopNewCount, 'success', null);

        console.log(`[Sync][Step1] └─ shop=${shopAlias} 완료  신규=${shopNewCount}건  ${ms(shopStart)}`);
        await updateProgress(jobId, step, totalSteps,
          `[Step1] ${shopAlias} 완료 - 신규 ${shopNewCount}건`);

      } catch (err) {
        console.error(`[Sync][Step1] └─ shop=${shopAlias} ERROR: ${err.message}  ${ms(shopStart)}`);
        await logSync(shop.shop_id, 'manual', null, null, 0, 0, 'fail', err.message);
      }
    }

    console.log(`[Sync] STEP 1 END  소요=${ms(step1Start)}`);

    // ───────────────────────────────────────────────────────────
    // STEP 2: 기존 주문 상태 업데이트
    // ───────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Sync] STEP 2 START — 미완료 주문 업데이트`);
    const step2Start = t();

    for (const shop of shops) {
      step++;
      const shopAlias = shop.alias || shop.shop_id;
      const shopStart = t();

      await updateProgress(jobId, step, totalSteps,
        `[Step2] ${shopAlias} 미완료 주문 업데이트 중...`);

      console.log(`\n[Sync][Step2] ┌─ shop=${shopAlias}`);

      try {
        // ── getNonFinalOrders (DB 조회) ──
        const dbQueryStart = t();
        const nonFinalOrders = await getNonFinalOrders(shop.shop_id);
        console.log(`[Sync][Step2] │  getNonFinalOrders: ${ms(dbQueryStart)}  → ${nonFinalOrders.length}건`);

        if (!nonFinalOrders.length) {
          console.log(`[Sync][Step2] └─ shop=${shopAlias} 업데이트 대상 없음  ${ms(shopStart)}`);
          await updateProgress(jobId, step, totalSteps,
            `[Step2] ${shopAlias} 업데이트 대상 없음`);
          continue;
        }

        // ── get_order_detail ──
        const orderSns = nonFinalOrders.map(o => o.order_sn);
        const detailStart = t();
        const details = await getOrderDetail(shop.shop_id, orderSns, account.access_token);
        console.log(`[Sync][Step2] │  get_order_detail: ${ms(detailStart)}  → ${details.length}건 (배치=${Math.ceil(orderSns.length/50)})`);

        // ── get_escrow_detail (5건씩 병렬) ──
        const escrowNeeded = details.filter(o =>
          ['COMPLETED', 'SHIPPED', 'PROCESSED', 'TO_CONFIRM_RECEIVE', 'READY_TO_SHIP'].includes(o.order_status)
        );
        console.log(`[Sync][Step2] │  escrow 대상: ${escrowNeeded.length}/${details.length}건  (${ESCROW_CONCURRENCY}건씩 병렬)`);

        const escrowMap = await fetchEscrowParallel(
          escrowNeeded, shop.shop_id, account.access_token, '[Sync][Step2]'
        );

        // ── diff + DB UPDATE ──
        const updateStart = t();
        let shopUpdated = 0;
        for (const order of details) {
          const dbRow = nonFinalOrders.find(o => o.order_sn === order.order_sn);
          if (!dbRow) continue;

          const escrow = escrowMap[order.order_sn] || null;
          const { orderRow } = mapOrderToDb(order, shop.shop_id, shop.region, escrow);

          const diff = diffOrderRow(dbRow, orderRow);
          if (Object.keys(diff).length > 0) {
            await updateOrder(order.order_sn, shop.shop_id, diff);
            shopUpdated++;
          }
        }
        console.log(`[Sync][Step2] │  diff+update: ${ms(updateStart)}  → 업데이트=${shopUpdated}건`);

        totalUpdated += shopUpdated;
        console.log(`[Sync][Step2] └─ shop=${shopAlias} 완료  업데이트=${shopUpdated}건  ${ms(shopStart)}`);
        await updateProgress(jobId, step, totalSteps,
          `[Step2] ${shopAlias} 완료 - 업데이트 ${shopUpdated}건`);

      } catch (err) {
        console.error(`[Sync][Step2] └─ shop=${shopAlias} ERROR: ${err.message}  ${ms(shopStart)}`);
      }
    }

    console.log(`[Sync] STEP 2 END  소요=${ms(step2Start)}`);

    // ───────────────────────────────────────────────────────────
    // STEP 3: tracking_number NULL 주문 업데이트
    // 대상: READY_TO_SHIP / PROCESSED / SHIPPED / COMPLETED 중 tracking_number IS NULL
    // ───────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Sync] STEP 3 START — tracking_number 보완`);
    const step3Start = t();

    // tracking_number 병렬 조회 상수 (rate limit 대응)
    const TRACKING_CONCURRENCY = 5;
    let totalTrackingUpdated = 0;

    for (const shop of shops) {
      step++;
      const shopAlias = shop.alias || shop.shop_id;
      const shopStart = t();

      await updateProgress(jobId, step, totalSteps,
        `[Step3] ${shopAlias} tracking_number 보완 중...`);

      console.log(`\n[Sync][Step3] ┌─ shop=${shopAlias}`);

      try {
        // tracking_number가 없는 배송 진행 주문 조회
        const [noTrackingOrders] = await db.query(
          `SELECT order_sn FROM orders
           WHERE shop_id = ?
             AND order_status IN ('READY_TO_SHIP','PROCESSED','SHIPPED','COMPLETED')
             AND (tracking_number IS NULL OR tracking_number = '')`,
          [shop.shop_id]
        );

        console.log(`[Sync][Step3] │  tracking 미확보 주문: ${noTrackingOrders.length}건`);

        if (!noTrackingOrders.length) {
          console.log(`[Sync][Step3] └─ shop=${shopAlias} 대상 없음  ${ms(shopStart)}`);
          await updateProgress(jobId, step, totalSteps,
            `[Step3] ${shopAlias} tracking 보완 대상 없음`);
          continue;
        }

        let shopTrackingUpdated = 0;

        // CONCURRENCY건씩 병렬 조회
        for (let i = 0; i < noTrackingOrders.length; i += TRACKING_CONCURRENCY) {
          const chunk = noTrackingOrders.slice(i, i + TRACKING_CONCURRENCY);
          const chunkStart = t();

          const results = await Promise.allSettled(
            chunk.map(({ order_sn }) =>
              getTrackingNumber(shop.shop_id, order_sn, account.access_token)
                .then(tn => ({ order_sn, tracking_number: tn }))
                .catch(e => ({ order_sn, tracking_number: null, error: e.message }))
            )
          );

          const batchIdx   = Math.floor(i / TRACKING_CONCURRENCY) + 1;
          const batchTotal = Math.ceil(noTrackingOrders.length / TRACKING_CONCURRENCY);

          for (const r of results) {
            const { order_sn, tracking_number, error } = r.value;
            if (tracking_number) {
              await db.query(
                `UPDATE orders SET tracking_number = ?, synced_at = NOW()
                 WHERE order_sn = ? AND shop_id = ?`,
                [tracking_number, order_sn, shop.shop_id]
              );
              shopTrackingUpdated++;
              console.log(`[Sync][Step3] │    ${order_sn} → ${tracking_number}`);
            } else {
              console.log(`[Sync][Step3] │    ${order_sn} → 없음 (${(error || 'null').slice(0, 40)})`);
            }
          }

          console.log(`[Sync][Step3] │  batch[${batchIdx}/${batchTotal}] ${chunk.length}건 완료: ${ms(chunkStart)}`);
        }

        totalTrackingUpdated += shopTrackingUpdated;
        console.log(`[Sync][Step3] └─ shop=${shopAlias} 완료  tracking 업데이트=${shopTrackingUpdated}건  ${ms(shopStart)}`);
        await updateProgress(jobId, step, totalSteps,
          `[Step3] ${shopAlias} 완료 - tracking 업데이트 ${shopTrackingUpdated}건`);

      } catch (err) {
        console.error(`[Sync][Step3] └─ shop=${shopAlias} ERROR: ${err.message}  ${ms(shopStart)}`);
      }
    }

    console.log(`[Sync] STEP 3 END  소요=${ms(step3Start)}`);

    await completeJob(jobId, {
      new_orders: totalNewOrders,
      updated_orders: totalUpdated,
      tracking_updated: totalTrackingUpdated,
    });

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[Sync] ■ DONE  new=${totalNewOrders}  updated=${totalUpdated}  tracking=${totalTrackingUpdated}  총소요=${ms(syncStart)}`);
    console.log(`${'═'.repeat(60)}\n`);

  } catch (err) {
    console.error(`[Sync] FATAL: ${err.message}  총소요=${ms(syncStart)}`);
    await failJob(jobId, err.message);
  }
}

module.exports = { runSync };
