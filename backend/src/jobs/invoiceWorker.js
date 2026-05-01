/**
 * invoiceWorker.js
 * 송장출력 백그라운드 Job  —  Shopee AWB 상단 크롭 + 커스텀 하단 합성
 *
 * 처리 흐름 (주문 상태별 분기):
 *
 *  READY_TO_SHIP
 *    ① ship_order  (이미 발송된 경우 → skip하고 ②로)
 *    ② get_tracking_number → orders 테이블 UPDATE
 *    ③ AWB PDF 다운로드 (create→poll→download)
 *    ④ AWB 상단 크롭 + 커스텀 하단 합성
 *
 *  PROCESSED / SHIPPED
 *    ① DB에 tracking_number 있으면 바로 사용
 *    ② 없으면 get_tracking_number → DB UPDATE
 *    ③ AWB PDF 다운로드
 *    ④ AWB 상단 크롭 + 커스텀 하단 합성
 *
 *  COMPLETED
 *    → Shopee API AWB 출력 불가 → "완료된 주문은 송장 출력 불가" skipped
 *
 *  UNPAID / PENDING / CANCELLED
 *    → 송장 발행 불가 skipped
 */

'use strict';

const db                          = require('../config/database');
const { buildInvoicePdf, mergePdfs } = require('../services/pdfBuilder');
const labelStorage                = require('../services/labelStorageService');
const { processInvoiceForOrder }  = require('../services/shopeeLogistics');
const { getOrRefreshShopToken } = require('../services/shopeeAuth');
const {
  startJob, updateProgress, updateJobResult, completeJob, failJob,
} = require('../services/jobManager');
const path = require('path');
const fs   = require('fs');

// ── 상수 ──────────────────────────────────────────────────────────
const MERGED_DIR = path.resolve(__dirname, '../../../data/shipping-labels/_merged');
if (!fs.existsSync(MERGED_DIR)) fs.mkdirSync(MERGED_DIR, { recursive: true });

// 즉시 스킵할 상태 (API 호출조차 불필요)
const HARD_SKIP_STATUSES = new Set(['UNPAID', 'PENDING', 'CANCELLED']);

// COMPLETED: API 호출해도 package_can_not_print — 즉시 명시적 메시지
const COMPLETED_SKIP_REASON = '완료된 주문은 Shopee API 정책상 AWB 재출력 불가';

// ── shop별 access_token 헬퍼 ───────────────────────────────────────
// 각 주문의 shop_id에 맞는 토큰을 shops 테이블에서 조회 (없으면 갱신)

// ── DB 헬퍼 ──────────────────────────────────────────────────────
async function saveTrackingToDB(orderSn, trackingNumber) {
  try {
    await db.query(
      'UPDATE orders SET tracking_number=? WHERE order_sn=?',
      [trackingNumber, orderSn]
    );
    console.log(`[InvoiceWorker] DB tracking_number saved: ${orderSn} → ${trackingNumber}`);
  } catch (e) {
    console.warn(`[InvoiceWorker] DB tracking_number save failed (${orderSn}): ${e.message}`);
  }
}

async function saveStatusToDB(orderSn, newStatus) {
  try {
    await db.query(
      'UPDATE orders SET order_status=? WHERE order_sn=?',
      [newStatus, orderSn]
    );
    console.log(`[InvoiceWorker] DB status updated: ${orderSn} → ${newStatus}`);
  } catch (e) {
    console.warn(`[InvoiceWorker] DB status update failed (${orderSn}): ${e.message}`);
  }
}

async function safeFailJob(jobId, message, context = 'unknown') {
  try {
    await failJob(jobId, message);
  } catch (failErr) {
    console.error(`[InvoiceWorker] failJob failed job=${jobId} context=${context}: ${failErr.message}`, failErr.stack);
  }
}

async function safeUpdateJobResult(jobId, resultData, context = 'unknown') {
  try {
    await updateJobResult(jobId, resultData);
  } catch (updateErr) {
    console.error(`[InvoiceWorker] updateJobResult failed job=${jobId} context=${context}: ${updateErr.message}`, updateErr.stack);
    throw updateErr;
  }
}

async function safeCompleteJob(jobId, resultData) {
  try {
    await completeJob(jobId, resultData);
  } catch (completeErr) {
    console.error(`[InvoiceWorker] completeJob failed job=${jobId}: ${completeErr.message}`, completeErr.stack);
    await safeFailJob(jobId, `completeJob failed: ${completeErr.message}`, 'completeJob');
    throw completeErr;
  }
}

// ════════════════════════════════════════════════════════════════
// 메인 Worker
// ════════════════════════════════════════════════════════════════
/**
 * @param {string} jobId
 * @param {Array}  orderSnList  — string[] 또는 {order_sn}[]
 */
async function runInvoice(jobId, orderSnList) {
  console.log(`[InvoiceWorker] start job=${jobId} orders=${orderSnList.length}`);

  try {
    await startJob(jobId, orderSnList.length);

    const orderSnStrings = orderSnList.map(o => (typeof o === 'string' ? o : o.order_sn));
    const placeholders   = orderSnStrings.map(() => '?').join(',');

    // ── DB 조회: 주문 기본 정보 ──────────────────────────────────
    const [orderRows] = await db.query(
      `SELECT o.order_sn, o.shop_id, o.order_status, o.tracking_number, o.currency,
              o.region, o.merchandise_subtotal, s.alias AS shop_alias
       FROM orders o
       LEFT JOIN shops s ON s.shop_id = o.shop_id
       WHERE o.order_sn IN (${placeholders})`,
      orderSnStrings
    );

    // ── DB 조회: 아이템 ──────────────────────────────────────────
    // model_discounted_price: 프로모션 묶음할인 시 Shopee가 특정 행에만
    // 할인가를 기록하고 나머지 행은 0으로 내려보냄.
    // → model_discounted_price > 0 이면 그 값, 아니면 model_original_price 사용
    const [itemRows] = await db.query(
      `SELECT
              oi.order_sn,
              COALESCE(NULLIF(p.product_name_kr, ''), oi.item_name) AS item_name,
              CASE
                WHEN p.product_name_kr IS NOT NULL AND p.product_name_kr != '' THEN ''
                ELSE oi.model_name
              END AS model_name,
              oi.model_quantity_purchased,
              CASE WHEN oi.model_discounted_price > 0
                   THEN oi.model_discounted_price
                   ELSE oi.model_original_price
              END AS unit_price
       FROM order_items oi
       LEFT JOIN products p
         ON p.sku COLLATE utf8mb4_general_ci = COALESCE(NULLIF(oi.model_sku, ''), NULLIF(oi.item_sku, '')) COLLATE utf8mb4_general_ci
       WHERE oi.order_sn IN (${placeholders})
       ORDER BY oi.order_sn, oi.id`,
      orderSnStrings
    );
    const itemsByOrder = {};
    for (const item of itemRows) {
      if (!itemsByOrder[item.order_sn]) itemsByOrder[item.order_sn] = [];
      itemsByOrder[item.order_sn].push(item);
    }

    // ── 주문별 처리 ───────────────────────────────────────────
    const results    = [];
    const pdfBuffers = [];
    const markOrderProcessed = async (index, orderSn) => {
      const processed = index + 1;
      const successCount = results.filter(r => r.status === 'success').length;
      const skippedCount = results.filter(r => r.status === 'skipped').length;
      const waitingCount = results.filter(r => r.status === 'waiting_label' || r.status === 'waiting_document').length;
      const errorCount = results.filter(r => r.status === 'error').length;
      await updateProgress(
        jobId,
        processed,
        orderRows.length,
        `송장 생성 중 ${processed}/${orderRows.length}: ${orderSn}`
      );
      await safeUpdateJobResult(jobId, {
        success: successCount,
        skipped: skippedCount,
        waiting: waitingCount,
        error: errorCount,
        total: orderRows.length,
        results,
      }, `progress:${orderSn}`);
    };

    for (let i = 0; i < orderRows.length; i++) {
      const order = orderRows[i];
      const { order_sn, shop_id, order_status, currency, merchandise_subtotal } = order;
      let   { tracking_number } = order;   // mutable — ship 후 갱신될 수 있음
      const items = itemsByOrder[order_sn] || [];

      await updateProgress(jobId, i, orderRows.length,
        `처리 중 (${i + 1}/${orderRows.length}): ${order_sn} [${order_status}]`);

      console.log(`[InvoiceWorker] ── [${i + 1}/${orderRows.length}] ${order_sn} status=${order_status} tracking=${tracking_number || 'none'}`);

      // ① 즉시 스킵 (UNPAID / PENDING / CANCELLED)
      if (HARD_SKIP_STATUSES.has(order_status)) {
        console.log(`[InvoiceWorker] hard-skip ${order_sn}: ${order_status}`);
        results.push({ order_sn, status: 'skipped', reason: `${order_status}: 송장 발행 불가` });
        await markOrderProcessed(i, order_sn);
        continue;
      }

      // ② COMPLETED: AWB 재출력 불가 — API 낭비 없이 즉시 skipped
      if (order_status === 'COMPLETED') {
        console.log(`[InvoiceWorker] completed-skip ${order_sn}`);
        results.push({ order_sn, status: 'skipped', reason: COMPLETED_SKIP_REASON });
        await markOrderProcessed(i, order_sn);
        continue;
      }

      // ③ PROCESSED / SHIPPED: tracking_number 없으면 먼저 조회
      //    (READY_TO_SHIP은 processInvoiceForOrder 내부에서 ship_order 후 취득)
      if (order_status !== 'READY_TO_SHIP' && !tracking_number) {
        console.log(`[InvoiceWorker] ${order_sn}: tracking_number 없음 — 스킵 (동기화 후 재시도)`);
        results.push({ order_sn, status: 'skipped', reason: '트래킹 번호 없음 — 동기화 후 다시 시도' });
        await markOrderProcessed(i, order_sn);
        continue;
      }

      // ④ 캐시 확인 (READY_TO_SHIP은 ship 후 새 AWB 필요하므로 캐시 무시)
      const useCache = (order_status !== 'READY_TO_SHIP');
      if (useCache && labelStorage.exists(shop_id, order_sn)) {
        const cached = labelStorage.load(shop_id, order_sn);
        if (cached) {
          console.log(`[InvoiceWorker] cache hit: ${order_sn}`);
          pdfBuffers.push(cached);
          results.push({ order_sn, status: 'success', reason: 'cache',
            filePath: labelStorage.filePath(shop_id, order_sn) });
          await markOrderProcessed(i, order_sn);
          continue;
        }
      }

      // ⑤ Shopee 물류 처리 + AWB 다운로드
      //    processInvoiceForOrder 내부:
      //      READY_TO_SHIP → ship_order(이미 발송이면 skip) → get_tracking_number → create→poll→download
      //      PROCESSED     → get_tracking_number(최신) → create→poll→download
      //      SHIPPED       → create→poll→download (실패 허용)
      let awbBuffer       = null;
      let resolvedTracking = tracking_number;

      // shop별 토큰 획득
      let accessToken;
      try {
        accessToken = await getOrRefreshShopToken(shop_id);
        if (!accessToken) throw new Error(`shop_id=${shop_id} 토큰 없음 — OAuth 재인증 필요`);
      } catch (authErr) {
        console.error(`[InvoiceWorker] auth error (shop_id=${shop_id}): ${authErr.message}`);
        results.push({ order_sn, status: 'error', reason: `인증 실패: ${authErr.message}` });
        await markOrderProcessed(i, order_sn);
        continue;
      }

      try {
        console.log(`[InvoiceWorker] processInvoiceForOrder START: ${order_sn} (${order_status})`);
        const lr = await processInvoiceForOrder({
          shopId:           shop_id,
          orderSn:          order_sn,
          orderStatus:      order_status,
          accessToken,
          existingTracking: tracking_number,
        });

        if (lr.skipped) {
          console.log(`[InvoiceWorker] logistics skipped ${order_sn}: ${lr.reason}`);
          results.push({
            order_sn,
            status: lr.status || 'skipped',
            reason: lr.reason || 'AWB 다운로드 불가',
          });
          await markOrderProcessed(i, order_sn);
          continue;
        }

        awbBuffer = lr.pdfBuffer;

        // tracking_number 갱신 (READY_TO_SHIP ship 후 새로 받은 경우 포함)
        if (lr.trackingNumber && lr.trackingNumber !== tracking_number) {
          resolvedTracking = lr.trackingNumber;
          await saveTrackingToDB(order_sn, resolvedTracking);
        }

        // 상태 갱신 (READY_TO_SHIP → PROCESSED)
        if (lr.statusUpdated) {
          await saveStatusToDB(order_sn, lr.statusUpdated);
        }

      } catch (awbErr) {
        console.error(`[InvoiceWorker] AWB error ${order_sn}: ${awbErr.message}`);
        results.push({ order_sn, status: 'error', reason: `AWB 다운로드 실패: ${awbErr.message}` });
        await markOrderProcessed(i, order_sn);
        continue;
      }

      if (!awbBuffer || awbBuffer.length === 0) {
        console.warn(`[InvoiceWorker] AWB buffer empty: ${order_sn}`);
        results.push({ order_sn, status: 'skipped', reason: 'AWB PDF 없음' });
        await markOrderProcessed(i, order_sn);
        continue;
      }

      // ⑥ AWB 상단 크롭 + 커스텀 하단 합성
      let finalPdf;
      try {
        finalPdf = await buildInvoicePdf({
          awbBuffer,
          items,
          orderSn:             order_sn,
          trackingNumber:      resolvedTracking,
          currency,
          merchandiseSubtotal: merchandise_subtotal,
        });
        console.log(`[InvoiceWorker] PDF built: ${order_sn} (${finalPdf.length} bytes)`);
      } catch (buildErr) {
        console.error(`[InvoiceWorker] buildInvoicePdf error ${order_sn}: ${buildErr.message}`);
        results.push({ order_sn, status: 'error', reason: `PDF 생성 실패: ${buildErr.message}` });
        await markOrderProcessed(i, order_sn);
        continue;
      }

      // ⑦ 저장
      try {
        const fp = await labelStorage.save(shop_id, order_sn, finalPdf, resolvedTracking);
        pdfBuffers.push(finalPdf);
        results.push({ order_sn, status: 'success', reason: null, filePath: fp });
      } catch (saveErr) {
        console.error(`[InvoiceWorker] save error ${order_sn}: ${saveErr.message}`);
        pdfBuffers.push(finalPdf);   // 저장 실패해도 병합에 포함
        results.push({ order_sn, status: 'success', reason: 'save_warn', filePath: null });
      }
      await markOrderProcessed(i, order_sn);
    } // end for

    // ── PDF 병합 ───────────────────────────────────────────────
    let mergedPath = null;
    if (pdfBuffers.length > 0) {
      try {
        const mergedPdf = await mergePdfs(pdfBuffers);
        mergedPath = path.join(MERGED_DIR, `${jobId}.pdf`);
        fs.writeFileSync(mergedPath, mergedPdf);
        console.log(`[InvoiceWorker] merged: ${mergedPath} (${mergedPdf.length} bytes)`);
      } catch (mergeErr) {
        console.error(`[InvoiceWorker] mergePdfs error: ${mergeErr.message}`);
      }
    }

    // ── 집계 & 완료 ───────────────────────────────────────────
    const successCount = results.filter(r => r.status === 'success').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const waitingCount = results.filter(r => r.status === 'waiting_label' || r.status === 'waiting_document').length;
    const errorCount   = results.filter(r => r.status === 'error').length;

    const finalResult = {
      success: successCount,
      skipped: skippedCount,
      waiting: waitingCount,
      error:   errorCount,
      total:   orderRows.length,
      merged_pdf_path: mergedPath,
      results,
    };

    await updateProgress(jobId, orderRows.length, orderRows.length, '완료');
    await safeUpdateJobResult(jobId, finalResult, 'final');

    if (successCount > 0 || skippedCount > 0 || waitingCount > 0) {
      await safeCompleteJob(jobId, finalResult);
    } else {
      const failMessage = errorCount > 0
        ? '송장 생성에 성공한 주문이 없습니다.'
        : '송장 생성 가능한 주문이 없습니다.';
      await safeFailJob(jobId, failMessage, 'no-success');
    }

    console.log(`[InvoiceWorker] done job=${jobId}: success=${successCount} skipped=${skippedCount} waiting=${waitingCount} error=${errorCount}`);

  } catch (fatalErr) {
    console.error(`[InvoiceWorker] fatal: ${fatalErr.message}`, fatalErr.stack);
    await safeFailJob(jobId, fatalErr.message, 'fatal');
  } finally {
    console.log(`[InvoiceWorker] release invoice lock for job=${jobId}`);
  }
}

module.exports = { runInvoice };
