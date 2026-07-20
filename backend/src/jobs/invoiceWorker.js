'use strict';

const path = require('path');
const fs = require('fs');

const db = require('../config/database');
const { CURRENT_TENANT_ID } = require('../config/tenant');
const { buildInvoicePdf, mergePdfs, splitPdfPages } = require('../services/pdfBuilder');
const labelStorage = require('../services/labelStorageService');
const {
  createAndDownload,
  createAndDownloadBatch,
  prepareReadyToShipForInvoice,
  resolveDocTypes,
  waitForInvoiceLabelReadyDelay,
  getTrackingNumber,
} = require('../services/shopeeLogistics');
const { getOrRefreshShopToken } = require('../services/shopeeAuth');
const {
  startJob,
  updateProgress,
  updateJobResult,
  completeJob,
  failJob,
} = require('../services/jobManager');
const {
  ensureShippingLabelStatusColumns,
  markLabelReady,
  markLabelPrinted,
  markLabelFailed,
} = require('../services/shippingLabelStatusService');

const MERGED_DIR = path.resolve(__dirname, '../../../data/shipping-labels/_merged');
if (!fs.existsSync(MERGED_DIR)) fs.mkdirSync(MERGED_DIR, { recursive: true });

const HARD_SKIP_STATUSES = new Set(['UNPAID', 'PENDING', 'CANCELLED']);
const COMPLETED_SKIP_REASON = 'Completed orders cannot be printed again through Shopee AWB API';
const SHIP_CONCURRENCY = Number(process.env.INVOICE_SHIP_CONCURRENCY || 2);
const DOWNLOAD_CHUNK_SIZE = Number(process.env.INVOICE_DOWNLOAD_CHUNK_SIZE || 5);
const INDIVIDUAL_DOWNLOAD_CONCURRENCY = Number(process.env.INVOICE_INDIVIDUAL_DOWNLOAD_CONCURRENCY || 1);
const TRACKING_POLL_TIMEOUT_MS = Number(process.env.INVOICE_TRACKING_POLL_TIMEOUT_MS || 30000);
const TRACKING_POLL_INTERVAL_MS = Number(process.env.INVOICE_TRACKING_POLL_INTERVAL_MS || 3000);
const TRACKING_POLL_CONCURRENCY = Number(process.env.INVOICE_TRACKING_POLL_CONCURRENCY || 5);

async function saveTrackingToDB(orderSn, trackingNumber, { tenantId = CURRENT_TENANT_ID, shopId } = {}) {
  try {
    await db.query(
      'UPDATE orders SET tracking_number=? WHERE tenant_id=? AND order_sn=? AND shop_id=?',
      [trackingNumber, tenantId, orderSn, shopId]
    );
    console.log(`[InvoiceWorker] DB tracking_number saved: ${orderSn} -> ${trackingNumber}`);
  } catch (err) {
    console.warn(`[InvoiceWorker] DB tracking_number save failed (${orderSn}): ${err.message}`);
  }
}

async function saveStatusToDB(orderSn, newStatus, { tenantId = CURRENT_TENANT_ID, shopId } = {}) {
  try {
    await db.query(
      'UPDATE orders SET order_status=? WHERE tenant_id=? AND order_sn=? AND shop_id=?',
      [newStatus, tenantId, orderSn, shopId]
    );
    console.log(`[InvoiceWorker] DB status updated: ${orderSn} -> ${newStatus}`);
  } catch (err) {
    console.warn(`[InvoiceWorker] DB status update failed (${orderSn}): ${err.message}`);
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

async function runWithConcurrency(items, limit, handler) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await handler(items[index], index);
      } catch (err) {
        results[index] = { error: err };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function isWaitingDocumentError(err) {
  return Boolean(err?.waitingDocument) ||
    /document.*not ready|label.*not ready|Shipping document not ready/i.test(err?.message || '');
}

async function runInvoice(jobId, orderSnList, { tenantId = CURRENT_TENANT_ID, prepareOnly = false } = {}) {
  console.log(`[InvoiceWorker] start job=${jobId} orders=${orderSnList.length} mode=${prepareOnly ? 'prepare' : 'print'}`);

  try {
    await ensureShippingLabelStatusColumns();
    await startJob(jobId, orderSnList.length);

    const orderSnStrings = orderSnList.map(o => (typeof o === 'string' ? o : o.order_sn));
    const placeholders = orderSnStrings.map(() => '?').join(',');

      const [orderRowsRaw] = await db.query(
        `SELECT o.tenant_id, o.order_sn, o.shop_id, o.order_status, o.tracking_number, o.currency,
                o.shipping_label_status,
                o.region, o.merchandise_subtotal, s.alias AS shop_alias
         FROM orders o
         LEFT JOIN shops s ON s.tenant_id = o.tenant_id AND s.shop_id = o.shop_id
         WHERE o.tenant_id = ?
           AND o.order_sn IN (${placeholders})`,
        [tenantId, ...orderSnStrings]
      );

    const orderRows = orderSnStrings
      .map(orderSn => orderRowsRaw.find(row => row.order_sn === orderSn))
      .filter(Boolean);

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
           ON p.tenant_id = oi.tenant_id
          AND p.sku COLLATE utf8mb4_general_ci = COALESCE(NULLIF(oi.model_sku, ''), NULLIF(oi.item_sku, '')) COLLATE utf8mb4_general_ci
         WHERE oi.tenant_id = ?
           AND oi.order_sn IN (${placeholders})
         ORDER BY oi.order_sn, oi.id`,
        [tenantId, ...orderSnStrings]
      );

    const itemsByOrder = {};
    for (const item of itemRows) {
      if (!itemsByOrder[item.order_sn]) itemsByOrder[item.order_sn] = [];
      itemsByOrder[item.order_sn].push(item);
    }

    const results = [];
    const pdfBuffers = [];
    const readyToShipOrders = [];
    const labelCandidates = [];
    const authTokenByShop = new Map();
    let processedCount = 0;

    const getAccessToken = async (shopId) => {
      if (!authTokenByShop.has(shopId)) {
        authTokenByShop.set(shopId, getOrRefreshShopToken(shopId));
      }
      const accessToken = await authTokenByShop.get(shopId);
      if (!accessToken) throw new Error(`shop_id=${shopId} token missing - OAuth re-auth required`);
      return accessToken;
    };

    const markOrderProcessed = async (orderSn) => {
      processedCount += 1;
      const successCount = results.filter(r => r.status === 'success').length;
      const skippedCount = results.filter(r => r.status === 'skipped').length;
      const waitingCount = results.filter(r => r.status === 'waiting_label' || r.status === 'waiting_document').length;
      const errorCount = results.filter(r => r.status === 'error').length;

      await updateProgress(jobId, processedCount, orderRows.length, `송장 생성 중 ${processedCount}/${orderRows.length}: ${orderSn}`);
      await safeUpdateJobResult(jobId, {
        success: successCount,
        skipped: skippedCount,
        waiting: waitingCount,
        error: errorCount,
        total: orderRows.length,
        results,
      }, `progress:${orderSn}`);
    };

    const pushBuiltPdf = async ({ order, awbBuffer, trackingNumber }) => {
      const finalPdf = await buildInvoicePdf({
        awbBuffer,
        items: itemsByOrder[order.order_sn] || [],
        orderSn: order.order_sn,
        trackingNumber,
        currency: order.currency,
        merchandiseSubtotal: order.merchandise_subtotal,
      });
      console.log(`[InvoiceWorker] PDF built: ${order.order_sn} (${finalPdf.length} bytes)`);

      try {
        const filePath = await labelStorage.save(order.shop_id, order.order_sn, finalPdf, trackingNumber, { tenantId });
        pdfBuffers.push(finalPdf);
        results.push({ order_sn: order.order_sn, status: 'success', reason: null, shop_id: order.shop_id, filePath });
      } catch (saveErr) {
        console.error(`[InvoiceWorker] save error ${order.order_sn}: ${saveErr.message}`);
        pdfBuffers.push(finalPdf);
        results.push({ order_sn: order.order_sn, status: 'success', reason: 'save_warn', shop_id: order.shop_id, filePath: null });
      }
    };

    const processCandidateIndividually = async (candidate, docType = null) => {
      const { order, accessToken } = candidate;
      try {
        const resolvedDocType = docType || (await resolveDocTypes(order.shop_id, [order.order_sn], accessToken)).get(order.order_sn);
        const awbBuffer = await createAndDownload(
          order.shop_id,
          order.order_sn,
          resolvedDocType,
          accessToken,
          candidate.trackingNumber
        );
        await pushBuiltPdf({ order, awbBuffer, trackingNumber: candidate.trackingNumber });
      } catch (err) {
        if (isWaitingDocumentError(err)) {
          results.push({
            order_sn: order.order_sn,
            status: 'waiting_label',
            reason: '송장 생성 대기 중입니다. Shopee에서 송장 준비가 끝난 뒤 다시 송장출력을 눌러주세요.',
            shop_id: order.shop_id,
          });
        } else {
          console.error(`[InvoiceWorker] individual document error ${order.order_sn}: ${err.message}`);
          results.push({ order_sn: order.order_sn, status: 'error', reason: `AWB 다운로드 실패: ${err.message}`, shop_id: order.shop_id });
          await markLabelFailed({ tenantId, shopId: order.shop_id, orderSn: order.order_sn, error: err.message });
        }
      }
      await markOrderProcessed(order.order_sn);
    };

    const processCandidateChunk = async (chunk, docType) => {
      if (chunk.length === 0) return;

      try {
        const batchPdf = await createAndDownloadBatch(
          chunk[0].order.shop_id,
          chunk.map(candidate => ({
            orderSn: candidate.order.order_sn,
            trackingNumber: candidate.trackingNumber,
          })),
          docType,
          chunk[0].accessToken
        );
        const pages = await splitPdfPages(batchPdf);

        if (pages.length !== chunk.length) {
          console.warn(`[InvoiceWorker] batch PDF page count mismatch expected=${chunk.length} actual=${pages.length}; falling back to individual downloads`);
          await runWithConcurrency(chunk, INDIVIDUAL_DOWNLOAD_CONCURRENCY, candidate => processCandidateIndividually(candidate, docType));
          return;
        }

        for (let i = 0; i < chunk.length; i++) {
          const candidate = chunk[i];
          try {
            await pushBuiltPdf({
              order: candidate.order,
              awbBuffer: pages[i],
              trackingNumber: candidate.trackingNumber,
            });
          } catch (buildErr) {
            console.error(`[InvoiceWorker] buildInvoicePdf error ${candidate.order.order_sn}: ${buildErr.message}`);
            results.push({
              order_sn: candidate.order.order_sn,
              status: 'error',
              reason: `PDF 생성 실패: ${buildErr.message}`,
              shop_id: candidate.order.shop_id,
            });
            await markLabelFailed({
              tenantId,
              shopId: candidate.order.shop_id,
              orderSn: candidate.order.order_sn,
              error: buildErr.message,
            });
          }
          await markOrderProcessed(candidate.order.order_sn);
        }
      } catch (batchErr) {
        if (isWaitingDocumentError(batchErr)) {
          console.warn(`[InvoiceWorker] batch document waiting: ${batchErr.message}`);
          for (const candidate of chunk) {
            results.push({
              order_sn: candidate.order.order_sn,
              status: 'waiting_label',
              reason: '송장 생성 대기 중입니다. Shopee에서 송장 준비가 끝난 뒤 다시 송장출력을 눌러주세요.',
              shop_id: candidate.order.shop_id,
            });
            await markOrderProcessed(candidate.order.order_sn);
          }
          return;
        }

        console.warn(`[InvoiceWorker] batch document failed, falling back to individual downloads: ${batchErr.message}`);
        await runWithConcurrency(chunk, INDIVIDUAL_DOWNLOAD_CONCURRENCY, candidate => processCandidateIndividually(candidate, docType));
      }
    };

    for (let i = 0; i < orderRows.length; i++) {
      const order = orderRows[i];
      const { order_sn, shop_id, order_status } = order;
      const trackingNumber = order.tracking_number;

      await updateProgress(jobId, processedCount, orderRows.length, `처리 중 (${i + 1}/${orderRows.length}): ${order_sn} [${order_status}]`);
      console.log(`[InvoiceWorker] prepare [${i + 1}/${orderRows.length}] ${order_sn} status=${order_status} tracking=${trackingNumber || 'none'}`);

      if (HARD_SKIP_STATUSES.has(order_status)) {
        results.push({ order_sn, status: 'skipped', reason: `${order_status}: 송장 발행 불가`, shop_id });
        await markOrderProcessed(order_sn);
        continue;
      }

      if (order_status === 'COMPLETED') {
        results.push({ order_sn, status: 'skipped', reason: COMPLETED_SKIP_REASON, shop_id });
        await markOrderProcessed(order_sn);
        continue;
      }

      const useCache = order_status !== 'READY_TO_SHIP';
      if (useCache && labelStorage.exists(shop_id, order_sn)) {
        const cached = labelStorage.load(shop_id, order_sn);
        if (cached) {
          console.log(`[InvoiceWorker] cache hit: ${order_sn}`);
          pdfBuffers.push(cached);
          results.push({
            order_sn,
            status: 'success',
            reason: 'cache',
            shop_id,
            filePath: labelStorage.filePath(shop_id, order_sn),
          });
          await markOrderProcessed(order_sn);
          continue;
        }
      }

      if (order_status !== 'READY_TO_SHIP' && !trackingNumber) {
        results.push({ order_sn, status: 'skipped', reason: 'tracking_number 없음 - 동기화 후 다시 시도', shop_id });
        await markOrderProcessed(order_sn);
        continue;
      }

      let accessToken;
      try {
        accessToken = await getAccessToken(shop_id);
      } catch (authErr) {
        console.error(`[InvoiceWorker] auth error shop=${shop_id}: ${authErr.message}`);
        results.push({ order_sn, status: 'error', reason: `인증 실패: ${authErr.message}`, shop_id });
        await markLabelFailed({ tenantId, shopId: shop_id, orderSn: order_sn, error: authErr.message });
        await markOrderProcessed(order_sn);
        continue;
      }

      if (order_status === 'READY_TO_SHIP') {
        readyToShipOrders.push({ order, accessToken, trackingNumber });
      } else {
        labelCandidates.push({ order, accessToken, trackingNumber });
      }
    }

    const readyResults = await runWithConcurrency(
      readyToShipOrders,
      SHIP_CONCURRENCY,
      async (entry) => {
        const orderSn = entry.order.order_sn;
        await updateProgress(jobId, processedCount, orderRows.length, `배송처리 중: ${orderSn} [READY_TO_SHIP]`);
        try {
          const prepared = await prepareReadyToShipForInvoice({
            shopId: entry.order.shop_id,
            orderSn,
            accessToken: entry.accessToken,
            existingTracking: entry.trackingNumber,
          });

          if (prepared.skipped) return { ...entry, skipped: true, prepared };

          if (prepared.trackingNumber && prepared.trackingNumber !== entry.trackingNumber) {
            await saveTrackingToDB(orderSn, prepared.trackingNumber, { tenantId, shopId: entry.order.shop_id });
          }
          if (prepared.statusUpdated) {
            await saveStatusToDB(orderSn, prepared.statusUpdated, { tenantId, shopId: entry.order.shop_id });
          }

          return { ...entry, trackingNumber: prepared.trackingNumber || entry.trackingNumber };
        } catch (err) {
          return { ...entry, error: err };
        }
      }
    );

    let shippedReadyCount = 0;
    for (const readyResult of readyResults) {
      if (readyResult.error) {
        console.error(`[InvoiceWorker] ship_order stage failed ${readyResult.order.order_sn}: ${readyResult.error.message}`);
        results.push({
          order_sn: readyResult.order.order_sn,
          status: 'error',
          reason: `배송처리 실패: ${readyResult.error.message}`,
          shop_id: readyResult.order.shop_id,
        });
        await markLabelFailed({
          tenantId,
          shopId: readyResult.order.shop_id,
          orderSn: readyResult.order.order_sn,
          error: readyResult.error.message,
        });
        await markOrderProcessed(readyResult.order.order_sn);
        continue;
      }

      if (readyResult.skipped) {
        results.push({
          order_sn: readyResult.order.order_sn,
          status: readyResult.prepared.status || 'skipped',
          reason: readyResult.prepared.reason || 'AWB 다운로드 불가',
          shop_id: readyResult.order.shop_id,
        });
        await markOrderProcessed(readyResult.order.order_sn);
        continue;
      }

      shippedReadyCount += 1;
      labelCandidates.push(readyResult);
    }

      if (shippedReadyCount > 0) {
        await waitForInvoiceLabelReadyDelay();

        const readyTrackingCandidates = labelCandidates.filter(candidate =>
          candidate.order.order_status === 'READY_TO_SHIP' && !candidate.trackingNumber
        );

        if (readyTrackingCandidates.length > 0) {
          const pendingByOrderSn = new Map(
            readyTrackingCandidates.map(candidate => [candidate.order.order_sn, candidate])
          );
          const deadline = Date.now() + Math.max(0, TRACKING_POLL_TIMEOUT_MS);
          const pollInterval = Math.max(1000, TRACKING_POLL_INTERVAL_MS);
          const pollConcurrency = Math.max(1, TRACKING_POLL_CONCURRENCY);

          console.log(`[InvoiceWorker] tracking poll start: pending=${pendingByOrderSn.size}, timeout=${TRACKING_POLL_TIMEOUT_MS}ms, interval=${pollInterval}ms, concurrency=${pollConcurrency}`);

          while (pendingByOrderSn.size > 0) {
            const pendingCandidates = Array.from(pendingByOrderSn.values());

            const pollResults = await runWithConcurrency(
              pendingCandidates,
              pollConcurrency,
              async candidate => {
                try {
                  const trackingNumber = await getTrackingNumber(
                    candidate.order.shop_id,
                    candidate.order.order_sn,
                    candidate.accessToken
                  );

                  return { candidate, trackingNumber: trackingNumber || null };
                } catch (err) {
                  return { candidate, error: err };
                }
              }
            );

            for (const pollResult of pollResults) {
              const orderSn = pollResult.candidate.order.order_sn;

              if (pollResult.error) {
                console.warn(`[InvoiceWorker] tracking poll error ${orderSn}: ${pollResult.error.message}`);
                continue;
              }

              if (pollResult.trackingNumber) {
                pollResult.candidate.trackingNumber = pollResult.trackingNumber;
                pendingByOrderSn.delete(orderSn);
                await saveTrackingToDB(orderSn, pollResult.trackingNumber, { tenantId, shopId: pollResult.candidate.order.shop_id });
                console.log(`[InvoiceWorker] tracking ready: ${orderSn} -> ${pollResult.trackingNumber}`);
              }
            }

            if (pendingByOrderSn.size === 0 || Date.now() >= deadline) {
              break;
            }

            await updateProgress(
              jobId,
              processedCount,
              orderRows.length,
              `운송장 번호 대기 중: ${pendingByOrderSn.size}건`
            );

            const waitMs = Math.min(pollInterval, Math.max(0, deadline - Date.now()));
            if (waitMs > 0) {
              await new Promise(resolve => setTimeout(resolve, waitMs));
            }
          }

          if (pendingByOrderSn.size > 0) {
            for (const candidate of pendingByOrderSn.values()) {
              console.warn(`[InvoiceWorker] tracking not ready: ${candidate.order.order_sn}`);
              results.push({
                order_sn: candidate.order.order_sn,
                status: 'waiting_label',
                reason: '운송장 번호 생성 대기 중입니다. 잠시 후 다시 송장출력을 눌러주세요.',
                shop_id: candidate.order.shop_id,
              });
              await markOrderProcessed(candidate.order.order_sn);
            }

            for (let i = labelCandidates.length - 1; i >= 0; i--) {
              if (pendingByOrderSn.has(labelCandidates[i].order.order_sn)) {
                labelCandidates.splice(i, 1);
              }
            }
          }
        }
      }

    const candidatesByShop = new Map();
    for (const candidate of labelCandidates) {
      const key = String(candidate.order.shop_id);
      if (!candidatesByShop.has(key)) candidatesByShop.set(key, []);
      candidatesByShop.get(key).push(candidate);
    }

    for (const candidates of candidatesByShop.values()) {
      const shopId = candidates[0].order.shop_id;
      const accessToken = candidates[0].accessToken;
      let docTypes;

      try {
        docTypes = await resolveDocTypes(shopId, candidates.map(candidate => candidate.order.order_sn), accessToken);
      } catch (docErr) {
        console.warn(`[InvoiceWorker] batch doc type resolve failed shop=${shopId}; falling back to individual: ${docErr.message}`);
        for (const candidate of candidates) await processCandidateIndividually(candidate);
        continue;
      }

      const candidatesByDocType = new Map();
      for (const candidate of candidates) {
        const docType = docTypes.get(candidate.order.order_sn);
        if (!candidatesByDocType.has(docType)) candidatesByDocType.set(docType, []);
        candidatesByDocType.get(docType).push(candidate);
      }

      for (const [docType, docCandidates] of candidatesByDocType.entries()) {
        for (const chunk of chunkArray(docCandidates, DOWNLOAD_CHUNK_SIZE)) {
          await processCandidateChunk(chunk, docType);
        }
      }
    }

    if (processedCount < orderRows.length) {
      console.warn(`[InvoiceWorker] progress mismatch processed=${processedCount} total=${orderRows.length}; marking unprocessed orders as error`);
      const finished = new Set(results.map(result => result.order_sn));
      for (const order of orderRows) {
        if (!finished.has(order.order_sn)) {
          results.push({ order_sn: order.order_sn, status: 'error', reason: '송장 작업이 완료되지 않았습니다.' });
          await markOrderProcessed(order.order_sn);
        }
      }
    }

    // Merge once at the end.
    let mergedPath = null;
    if (!prepareOnly && pdfBuffers.length === 1) {
      const successResult = results.find(result => result.status === 'success' && result.filePath);
      if (successResult?.filePath && fs.existsSync(successResult.filePath)) {
        mergedPath = successResult.filePath;
        console.log(`[InvoiceWorker] single PDF: ${mergedPath}`);
      }
    } else if (!prepareOnly && pdfBuffers.length > 1) {
      try {
        const mergedPdf = await mergePdfs(pdfBuffers);
        mergedPath = path.join(MERGED_DIR, `${jobId}.pdf`);
        fs.writeFileSync(mergedPath, mergedPdf);
        console.log(`[InvoiceWorker] merged: ${mergedPath} (${mergedPdf.length} bytes)`);
      } catch (mergeErr) {
        console.error(`[InvoiceWorker] mergePdfs error: ${mergeErr.message}`);
      }
    }

    const successCount = results.filter(r => r.status === 'success').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const waitingCount = results.filter(r => r.status === 'waiting_label' || r.status === 'waiting_document').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    const finalResult = {
      mode: prepareOnly ? 'prepare' : 'print',
      success: successCount,
      skipped: skippedCount,
      waiting: waitingCount,
      error: errorCount,
      total: orderRows.length,
      merged_pdf_path: mergedPath,
      results,
    };

    for (const result of results) {
      if (result.status !== 'success' || !result.shop_id) continue;
      if (prepareOnly) {
        await markLabelReady({ tenantId, shopId: result.shop_id, orderSn: result.order_sn });
      } else {
        await markLabelPrinted({ tenantId, shopId: result.shop_id, orderSn: result.order_sn });
      }
    }

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
