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
const { CURRENT_TENANT_ID } = require('../config/tenant');
const { getOrRefreshShopToken } = require('../services/shopeeAuth');
const {
  getOrderList,
  getOrderDetail,
  getEscrowDetail,
  getTrackingNumber,
  mapOrderToDb,
} = require('../services/shopeeOrder');
const {
  getLatestCreateTime,
  getNonFinalOrders,
  logSync,
} = require('../services/orderDb');
const { applyShopeeOrderSnapshot } = require('../services/orderSnapshotService');
const {
  startJob,
  updateProgress,
  completeJob,
  failJob,
} = require('../services/jobManager');
const { sleep } = require('../utils/apiWrapper');
const { getShippingParameter } = require('../services/shopeeLogistics');
const { syncReturnWindow } = require('../services/shopeeReturn');
const {
  calculateDiscoveryRange,
  buildOrderListWindows,
} = require('./orderDiscoveryRange');

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

function mysqlDateTimeNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function isPendingShippingParameterError(err) {
  const msg = err?.message || '';
  return (
    /Shipping parameters can only be obtained when package is ready to be shipped/i.test(msg) ||
    /buyer TW KYC/i.test(msg) ||
    /KYC/i.test(msg) ||
    /package.*ready to be shipped/i.test(msg)
  );
}

async function resolveDisplayStatuses(orders, shopId, accessToken, label) {
  const result = new Map();

  for (const order of orders) {
    const checkedAt = mysqlDateTimeNow();

    if (order.order_status !== 'READY_TO_SHIP') {
      result.set(order.order_sn, {
        display_status: order.order_status,
        display_status_reason: null,
        display_status_checked_at: checkedAt,
      });
      continue;
    }

    try {
      await getShippingParameter(shopId, order.order_sn, accessToken);
      result.set(order.order_sn, {
        display_status: 'READY_TO_SHIP',
        display_status_reason: null,
        display_status_checked_at: checkedAt,
      });
      console.log(`${label} │    display_status[${order.order_sn}]: READY_TO_SHIP`);
    } catch (err) {
      if (isPendingShippingParameterError(err)) {
        result.set(order.order_sn, {
          display_status: 'PENDING',
          display_status_reason: 'Shipping parameters can only be obtained when package is ready to be shipped',
          display_status_checked_at: checkedAt,
        });
        console.log(`${label} │    display_status[${order.order_sn}]: PENDING (${err.message.slice(0, 120)})`);
      } else {
        result.set(order.order_sn, {
          display_status: 'READY_TO_SHIP',
          display_status_reason: `display_status check failed: ${err.message.slice(0, 200)}`,
          display_status_checked_at: checkedAt,
        });
        console.warn(`${label} │    display_status[${order.order_sn}]: CHECK_FAILED -> READY_TO_SHIP (${err.message.slice(0, 120)})`);
      }
    }
  }

  return result;
}

function applyDisplayStatus(orderRow, displayStatus) {
  orderRow.display_status = displayStatus?.display_status || orderRow.order_status;
  orderRow.display_status_reason = displayStatus?.display_status_reason || null;
  orderRow.display_status_checked_at = displayStatus?.display_status_checked_at || mysqlDateTimeNow();
}

function getAlertItemSku(item) {
  return String(item?.model_sku || item?.item_sku || '').trim();
}

function getAlertFallbackName(item) {
  const itemName = String(item?.item_name || '').trim();
  const modelName = String(item?.model_name || '').trim();
  if (itemName && modelName && modelName !== '-') return `${itemName} / ${modelName}`;
  return itemName || modelName || getAlertItemSku(item) || '-';
}

async function getProductNameMapForAlert(skus, tenantId) {
  const cleanSkus = Array.from(new Set(
    (skus || [])
      .map(sku => String(sku || '').trim())
      .filter(Boolean)
  ));

  if (!cleanSkus.length) return new Map();

  const placeholders = cleanSkus.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT sku, product_name_kr, product_name_en
     FROM products
     WHERE tenant_id = ?
       AND sku IN (${placeholders})`,
    [tenantId, ...cleanSkus]
  );

  return new Map(rows.map(row => [String(row.sku || '').trim(), row]));
}

async function buildReadyToShipAlertItemsFromRows({ orderRows, itemRows, shop, tenantId }) {
  const readyOrderSns = new Set(
    (orderRows || [])
      .filter(order => order.display_status === 'READY_TO_SHIP')
      .map(order => order.order_sn)
      .filter(Boolean)
  );

  if (!readyOrderSns.size) return [];

  const targetItems = (itemRows || []).filter(item => readyOrderSns.has(item.order_sn));
  const productMap = await getProductNameMapForAlert(targetItems.map(getAlertItemSku), tenantId);

  return targetItems.map(item => {
    const sku = getAlertItemSku(item);
    const product = productMap.get(sku) || {};
    return {
      region: shop.region || shop.alias || String(shop.shop_id),
      orderSn: item.order_sn,
      sku,
      productName: product.product_name_kr || getAlertFallbackName(item) || product.product_name_en || sku || '-',
      optionName: item.model_name || '',
      qty: Number(item.model_quantity_purchased || 1),
    };
  });
}

async function buildReadyToShipAlertItemsFromDb({ orderSns, shop, tenantId }) {
  const cleanOrderSns = Array.from(new Set(
    (orderSns || [])
      .map(orderSn => String(orderSn || '').trim())
      .filter(Boolean)
  ));

  if (!cleanOrderSns.length) return [];

  const placeholders = cleanOrderSns.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT
       oi.order_sn,
       oi.item_name,
       oi.item_sku,
       oi.model_name,
       oi.model_sku,
       oi.model_quantity_purchased,
       p.product_name_kr,
       p.product_name_en
     FROM order_items oi
     LEFT JOIN products p
       ON p.tenant_id = oi.tenant_id
      AND p.sku = COALESCE(NULLIF(oi.model_sku, ''), NULLIF(oi.item_sku, ''))
     WHERE oi.tenant_id = ?
       AND oi.shop_id = ?
       AND oi.order_sn IN (${placeholders})
     ORDER BY oi.order_sn ASC, oi.id ASC`,
    [tenantId, shop.shop_id, ...cleanOrderSns]
  );

  return rows.map(row => {
    const sku = String(row.model_sku || row.item_sku || '').trim();
    return {
      region: shop.region || shop.alias || String(shop.shop_id),
      orderSn: row.order_sn,
      sku,
      productName: row.product_name_kr || getAlertFallbackName(row) || row.product_name_en || sku || '-',
      optionName: row.model_name || '',
      qty: Number(row.model_quantity_purchased || 1),
    };
  });
}


/**
 * 수동 동기화 메인 실행 함수
 * @param {string} jobId
 */
async function runSync(jobId, { tenantId = CURRENT_TENANT_ID, discoveryMode = 'normal_overlap' } = {}) {
  const syncStart = t();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Sync] ▶ START  jobId=${jobId}  ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    const [shops] = await db.query(
        'SELECT shop_id, alias, region FROM shops WHERE tenant_id = ? AND is_active = 1 ORDER BY id ASC',
        [tenantId]
      );
    if (!shops.length) {
      await failJob(jobId, '활성화된 샵이 없습니다');
      return;
    }

    console.log(`[Sync] 활성 샵 ${shops.length}개: ${shops.map(s => s.alias || s.shop_id).join(', ')}`);

    // 전체 스텝: 샵 × 4
    // Step1 주문 수집
    // Step2 미완료 주문 갱신
    // Step3 tracking 보완
    // Step4 Return/Refund 동기화
    const totalSteps = shops.length * 4;
    await startJob(jobId, totalSteps);

    let step = 0;
    let totalNewOrders = 0;
    let totalUpdated = 0;
    let totalReturnRefundSynced = 0;
    const newOrdersByRegion = {}; // { MY: n, SG: n, TW: n }
    let totalReadyToShipAlertOrders = 0;
    const readyToShipAlertOrdersByRegion = {}; // 새주문 알림 대상: READY_TO_SHIP only
    const readyToShipAlertItems = [];

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
        const latestTs = await getLatestCreateTime(shop.shop_id, { tenantId });
        console.log(`[Sync][Step1] │  getLatestCreateTime: ${ms(tsStart)}  → latestTs=${latestTs ? new Date(latestTs*1000).toISOString() : 'none(최초)'}`);

        const now = Math.floor(Date.now() / 1000);
        const { timeFrom, timeTo } = calculateDiscoveryRange(latestTs, now, discoveryMode);

        // Shopee 최대 조회 범위 15일 → 슬라이딩 윈도우
        const windows = buildOrderListWindows(timeFrom, timeTo);
        console.log(`[Sync][Step1] │  시간 범위: ${new Date(timeFrom*1000).toISOString().slice(0,10)} ~ ${new Date(timeTo*1000).toISOString().slice(0,10)}  윈도우 ${windows.length}개`);

        let shopNewCount = 0;
        let shopFetchedCount = 0;
        let shopExistingCount = 0;
        let shopPageCount = 0;
          let shopReadyToShipAlertCount = 0;

        for (const [wi, win] of windows.entries()) {
          const winLabel = `win[${wi+1}/${windows.length}]`;

          // ── get_order_list ──
          const shopToken1 = await getOrRefreshShopToken(shop.shop_id);
          if (!shopToken1) throw new Error(`shop_id=${shop.shop_id} 토큰 없음 — OAuth 재인증 필요`);
          const listStart = t();
          const { orderSns: allSns, pageCount } = await getOrderList(
            shop.shop_id, win.from, win.to, shopToken1, { withMeta: true }
          );
          shopFetchedCount += allSns.length;
          shopPageCount += pageCount;
          console.log(`[Sync][Step1] │  get_order_list ${winLabel}: ${ms(listStart)}  → ${allSns.length}건`);

          // Existing orders are re-read so missing item rows can self-heal.
          const detailSns = allSns;

          if (detailSns.length > 0) {
            // ── get_order_detail ──
            const shopToken1d = await getOrRefreshShopToken(shop.shop_id);
            if (!shopToken1d) throw new Error(`shop_id=${shop.shop_id} 토큰 없음`);
            const detailStart = t();
            const details = await getOrderDetail(shop.shop_id, detailSns, shopToken1d);
            console.log(`[Sync][Step1] │  get_order_detail ${winLabel}: ${ms(detailStart)}  → ${details.length}건 (배치=${Math.ceil(detailSns.length/50)})`);

            // ── get_escrow_detail (5건씩 병렬) ──
            const escrowNeededOrders = details.filter(o =>
              ['COMPLETED', 'SHIPPED', 'PROCESSED', 'TO_CONFIRM_RECEIVE', 'READY_TO_SHIP'].includes(o.order_status)
            );
            console.log(`[Sync][Step1] │  escrow 대상: ${escrowNeededOrders.length}/${details.length}건  (${ESCROW_CONCURRENCY}건씩 병렬)`);

            const escrowMap1 = await fetchEscrowParallel(
              escrowNeededOrders, shop.shop_id, shopToken1d, '[Sync][Step1]'
            );

              const displayStatusMap1 = await resolveDisplayStatuses(details, shop.shop_id, shopToken1d, '[Sync][Step1]');

            const orderRows = [];
            const itemRowsAll = [];

            for (const order of details) {
              const escrow = escrowMap1[order.order_sn] || null;
              const { orderRow, itemRows } = mapOrderToDb(order, shop.shop_id, shop.region, escrow);
              applyDisplayStatus(orderRow, displayStatusMap1.get(order.order_sn));
              orderRows.push(orderRow);
              itemRowsAll.push(...itemRows);
            }

            // ── DB INSERT ──
            const insertStart = t();
            const insertedKeySet = new Set();
            for (const orderRow of orderRows) {
              const orderItems = itemRowsAll.filter(item => item.order_sn === orderRow.order_sn);
              const applied = await applyShopeeOrderSnapshot({
                tenantId,
                shopId: shop.shop_id,
                orderRow,
                itemRows: orderItems,
                source: discoveryMode,
              });
              if (applied.created) insertedKeySet.add(`${orderRow.shop_id}::${orderRow.order_sn}`);
              else shopExistingCount++;
            }
            const inserted = insertedKeySet.size;
            const insertedItemRows = itemRowsAll.filter(item =>
              insertedKeySet.has(`${item.shop_id}::${item.order_sn}`)
            );
            console.log(`[Sync][Step1] │  batchInsert: ${ms(insertStart)}  → inserted=${inserted}`);
              const readyToShipInserted = orderRows.filter(order =>
                insertedKeySet.has(`${order.shop_id}::${order.order_sn}`) &&
                order.display_status === 'READY_TO_SHIP'
              ).length;
              shopReadyToShipAlertCount += readyToShipInserted;
              if (readyToShipInserted > 0) {
                console.log(`[Sync][Step1] │  새주문 알림 대상 READY_TO_SHIP=${readyToShipInserted}건`);
                const insertedOrderRows = orderRows.filter(order =>
                  insertedKeySet.has(`${order.shop_id}::${order.order_sn}`)
                );
                readyToShipAlertItems.push(...await buildReadyToShipAlertItemsFromRows({
                  orderRows: insertedOrderRows,
                  itemRows: insertedItemRows,
                  shop,
                  tenantId,
                }));
              }

            shopNewCount += inserted;
          }

          if (windows.length > 1) await sleep(1000);
        }

        totalNewOrders += shopNewCount;
        if (shopNewCount > 0) {
          newOrdersByRegion[shop.region] = (newOrdersByRegion[shop.region] || 0) + shopNewCount;
        }
          totalReadyToShipAlertOrders += shopReadyToShipAlertCount;
          if (shopReadyToShipAlertCount > 0) {
            readyToShipAlertOrdersByRegion[shop.region] = (readyToShipAlertOrdersByRegion[shop.region] || 0) + shopReadyToShipAlertCount;
          }
        await logSync(shop.shop_id, 'manual', new Date(timeFrom * 1000), new Date(timeTo * 1000),
            shopFetchedCount, shopNewCount, 'success', null, { tenantId });

        console.log(
          `[OrderDiscovery] shop_id=${shop.shop_id} tenant_id=${tenantId} mode=${discoveryMode} ` +
          `time_from=${new Date(timeFrom * 1000).toISOString()} time_to=${new Date(timeTo * 1000).toISOString()} ` +
          `api_orders=${shopFetchedCount} inserted=${shopNewCount} existing=${shopExistingCount} ` +
          `errors=0 cursor_pages=${shopPageCount}`
        );

        console.log(`[Sync][Step1] └─ shop=${shopAlias} 완료  신규=${shopNewCount}건  ${ms(shopStart)}`);
        await updateProgress(jobId, step, totalSteps,
          `[Step1] ${shopAlias} 완료 - 신규 ${shopNewCount}건`);

      } catch (err) {
        console.error(`[Sync][Step1] └─ shop=${shopAlias} ERROR: ${err.message}  ${ms(shopStart)}`);
        console.error(
          `[OrderDiscovery] shop_id=${shop.shop_id} tenant_id=${tenantId} mode=${discoveryMode} ` +
          `api_orders=0 inserted=0 existing=0 errors=1 cursor_pages=0 error=${err.message}`
        );
        await logSync(shop.shop_id, 'manual', null, null, 0, 0, 'fail', err.message, { tenantId });
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
        const nonFinalOrders = await getNonFinalOrders(shop.shop_id, { tenantId });
        console.log(`[Sync][Step2] │  getNonFinalOrders: ${ms(dbQueryStart)}  → ${nonFinalOrders.length}건`);

        if (!nonFinalOrders.length) {
          console.log(`[Sync][Step2] └─ shop=${shopAlias} 업데이트 대상 없음  ${ms(shopStart)}`);
          await updateProgress(jobId, step, totalSteps,
            `[Step2] ${shopAlias} 업데이트 대상 없음`);
          continue;
        }

        // ── get_order_detail ──
        const shopToken2 = await getOrRefreshShopToken(shop.shop_id);
        if (!shopToken2) throw new Error(`shop_id=${shop.shop_id} 토큰 없음`);
        const orderSns = nonFinalOrders.map(o => o.order_sn);
        const detailStart = t();
        const details = await getOrderDetail(shop.shop_id, orderSns, shopToken2);
        console.log(`[Sync][Step2] │  get_order_detail: ${ms(detailStart)}  → ${details.length}건 (배치=${Math.ceil(orderSns.length/50)})`);

        // ── get_escrow_detail (5건씩 병렬) ──
        const escrowNeeded = details.filter(o =>
          ['COMPLETED', 'SHIPPED', 'PROCESSED', 'TO_CONFIRM_RECEIVE', 'READY_TO_SHIP'].includes(o.order_status)
        );
        console.log(`[Sync][Step2] │  escrow 대상: ${escrowNeeded.length}/${details.length}건  (${ESCROW_CONCURRENCY}건씩 병렬)`);

        const escrowMap = await fetchEscrowParallel(
          escrowNeeded, shop.shop_id, shopToken2, '[Sync][Step2]'
        );

          const displayStatusMap2 = await resolveDisplayStatuses(details, shop.shop_id, shopToken2, '[Sync][Step2]');

        // ── diff + DB UPDATE ──
        const updateStart = t();
        let shopUpdated = 0;
          let shopReadyToShipAlertCount = 0;
          const shopReadyToShipAlertOrderSns = [];
        for (const order of details) {
          const dbRow = nonFinalOrders.find(o => o.order_sn === order.order_sn);
          if (!dbRow) continue;

          const escrow = escrowMap[order.order_sn] || null;
          const { orderRow, itemRows } = mapOrderToDb(order, shop.shop_id, shop.region, escrow);

          applyDisplayStatus(orderRow, displayStatusMap2.get(order.order_sn));


          const applied = await applyShopeeOrderSnapshot({
            tenantId,
            shopId: shop.shop_id,
            orderRow,
            itemRows,
            source: 'polling',
          });
          if (applied.updated) {
            if (applied.previousDisplayStatus !== 'READY_TO_SHIP' && applied.displayStatus === 'READY_TO_SHIP') {
              shopReadyToShipAlertCount++;
              shopReadyToShipAlertOrderSns.push(order.order_sn);
            }
            shopUpdated++;
          }
        }
        console.log(`[Sync][Step2] │  diff+update: ${ms(updateStart)}  → 업데이트=${shopUpdated}건`);

        totalUpdated += shopUpdated;
          totalReadyToShipAlertOrders += shopReadyToShipAlertCount;
          if (shopReadyToShipAlertCount > 0) {
            readyToShipAlertOrdersByRegion[shop.region] = (readyToShipAlertOrdersByRegion[shop.region] || 0) + shopReadyToShipAlertCount;
            readyToShipAlertItems.push(...await buildReadyToShipAlertItemsFromDb({
              orderSns: shopReadyToShipAlertOrderSns,
              shop,
              tenantId,
            }));
          }

          console.log(`[Sync][Step2] └─ shop=${shopAlias} 완료  업데이트=${shopUpdated}건  새주문알림대상=${shopReadyToShipAlertCount}건  ${ms(shopStart)}`);
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
             WHERE tenant_id = ?
               AND shop_id = ?
               AND order_status IN ('READY_TO_SHIP','PROCESSED','SHIPPED','COMPLETED')
               AND (tracking_number IS NULL OR tracking_number = '')`,
            [tenantId, shop.shop_id]
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

          const shopToken3 = await getOrRefreshShopToken(shop.shop_id);
          if (!shopToken3) { console.error(`[Sync][Step3] shop_id=${shop.shop_id} 토큰 없음, tracking skip`); break; }

          const results = await Promise.allSettled(
            chunk.map(({ order_sn }) =>
              getTrackingNumber(shop.shop_id, order_sn, shopToken3)
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
                   WHERE tenant_id = ? AND order_sn = ? AND shop_id = ?`,
                  [tracking_number, tenantId, order_sn, shop.shop_id]
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

    // ───────────────────────────────────────────────────────────
    // STEP 4: Return/Refund 최근 15일 갱신
    // 기존 주문 수동/자동 동기화와 함께 실행
    // ───────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[Sync] STEP 4 START — Return/Refund 동기화`);
    const step4Start = t();

    for (const shop of shops) {
      step++;

      const shopAlias = shop.alias || shop.shop_id;
      const shopStart = t();

      await updateProgress(
        jobId,
        step,
        totalSteps,
        `[Step4] ${shopAlias} 반품/환불 동기화 중...`
      );

      console.log(
        `\n[Sync][Step4] ┌─ shop=${shopAlias}`
      );

      try {
        const shopToken4 = await getOrRefreshShopToken(
          shop.shop_id
        );

        if (!shopToken4) {
          throw new Error(
            `shop_id=${shop.shop_id} 토큰 없음`
          );
        }

        const now = Math.floor(Date.now() / 1000);

        /*
         * API 최대 범위가 15일이므로 14일 23시간 59분 사용.
         * update_time 기준이라 기존 Return 상태 변경도 다시 가져온다.
         */
        const timeFrom = now - (15 * 86400) + 1;
        const timeTo = now;

        const result = await syncReturnWindow({
          tenantId,
          shopId: shop.shop_id,
          accessToken: shopToken4,
          timeFrom,
          timeTo,
          timeField: 'update_time',
        });

        totalReturnRefundSynced += result.synced;

        console.log(
          `[Sync][Step4] └─ shop=${shopAlias}` +
          ` 목록=${result.listed}건` +
          ` 저장=${result.synced}건` +
          ` ${ms(shopStart)}`
        );

        await updateProgress(
          jobId,
          step,
          totalSteps,
          `[Step4] ${shopAlias} 완료 - 반품/환불 ${result.synced}건`
        );
      } catch (error) {
        /*
         * Return API 장애가 일반 주문 동기화 전체를 실패시키지 않도록
         * 샵 단위로 로그만 남기고 다음 샵을 계속 진행한다.
         */
        console.error(
          `[Sync][Step4] └─ shop=${shopAlias}` +
          ` ERROR: ${error.message}` +
          ` ${ms(shopStart)}`
        );

        await updateProgress(
          jobId,
          step,
          totalSteps,
          `[Step4] ${shopAlias} 반품/환불 동기화 실패`
        );
      }
    }

    console.log(
      `[Sync] STEP 4 END` +
      ` 저장=${totalReturnRefundSynced}건` +
      ` 소요=${ms(step4Start)}`
    );

    await completeJob(jobId, {
      new_orders: totalNewOrders,
      updated_orders: totalUpdated,
      tracking_updated: totalTrackingUpdated,
      return_refunds_synced: totalReturnRefundSynced,
      new_orders_by_region: newOrdersByRegion,
      ready_to_ship_new_orders: totalReadyToShipAlertOrders,
      ready_to_ship_new_orders_by_region: readyToShipAlertOrdersByRegion,
      ready_to_ship_new_order_items: readyToShipAlertItems,
      ready_to_ship_new_order_items: readyToShipAlertItems,
    });

    console.log(`\n${'═'.repeat(60)}`);
    console.log(
      `[Sync] ■ DONE` +
      ` new=${totalNewOrders}` +
      ` updated=${totalUpdated}` +
      ` tracking=${totalTrackingUpdated}` +
      ` return_refund=${totalReturnRefundSynced}` +
      ` 총소요=${ms(syncStart)}`
    );
    console.log(`${'═'.repeat(60)}\n`);

    // 호출자(autoSyncJob)에서 텔레그램 알림에 활용할 수 있도록 결과 반환
    return {
      new_orders: totalNewOrders,
      return_refunds_synced: totalReturnRefundSynced,
      new_orders_by_region: newOrdersByRegion,
      ready_to_ship_new_orders: totalReadyToShipAlertOrders,
      ready_to_ship_new_orders_by_region: readyToShipAlertOrdersByRegion,
    };

  } catch (err) {
    console.error(`[Sync] FATAL: ${err.message}  총소요=${ms(syncStart)}`);
    await failJob(jobId, err.message);
  }
}

async function runReconciliation(jobId, { tenantId = CURRENT_TENANT_ID } = {}) {
  return runSync(jobId, { tenantId, discoveryMode: 'reconciliation' });
}

module.exports = {
  runSync,
  runReconciliation,
  calculateDiscoveryRange,
  buildOrderListWindows,
};
