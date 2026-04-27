/**
 * invoiceRoutes.js
 *
 * POST /api/invoice/start    - 송장 Job 시작 (order_sn_list 배열 전달)
 * GET  /api/invoice/download/:jobId - 생성된 합성 PDF 다운로드
 * GET  /api/invoice/:orderSn/download - 캐시된 단일 PDF 다운로드
 */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const { requireAuth }  = require('../middleware/auth');
const { createJob, getJob, getRunningJob } = require('../services/jobManager');
const { runInvoice }   = require('../jobs/invoiceWorker');
const labelStorage     = require('../services/labelStorageService');
const db               = require('../config/database');

router.use(requireAuth);

// ─── POST /api/invoice/start ──────────────────────────────────────
router.post('/start', async (req, res) => {
  const { order_sn_list } = req.body;

  if (!Array.isArray(order_sn_list) || order_sn_list.length === 0) {
    return res.status(400).json({ success: false, error: '주문 목록이 비어있습니다.' });
  }

  if (order_sn_list.length > 50) {
    return res.status(400).json({ success: false, error: '한 번에 최대 50건까지 가능합니다.' });
  }

  // 중복 실행 방지
  const running = await getRunningJob('invoice');
  if (running) {
    return res.status(409).json({
      success: false,
      error: 'ALREADY_RUNNING',
      message: '송장출력 작업이 이미 진행 중입니다.',
      job_id: running.id,
    });
  }

  const jobId = await createJob('invoice');

  // 백그라운드 실행
  runInvoice(jobId, order_sn_list).catch(err => {
    console.error('[InvoiceRoute] Unhandled error:', err.message);
  });

  return res.json({
    success: true,
    job_id: jobId,
    message: `송장출력 시작: ${order_sn_list.length}건`,
  });
});

// ─── GET /api/invoice/download/:jobId ────────────────────────────
// Job 완료 후 합성 PDF 다운로드
router.get('/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = await getJob(jobId);

  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  if (job.status !== 'completed') {
    return res.status(400).json({ success: false, error: `Job status: ${job.status}` });
  }

  const resultData = typeof job.result_data === 'string'
    ? JSON.parse(job.result_data)
    : job.result_data;

  const mergedPath = resultData?.merged_pdf_path;
  if (!mergedPath || !fs.existsSync(mergedPath)) {
    return res.status(404).json({ success: false, error: 'PDF 파일을 찾을 수 없습니다.' });
  }

  const fileName = `invoices_${new Date().toISOString().slice(0,10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  fs.createReadStream(mergedPath).pipe(res);
});

// ─── GET /api/invoice/:orderSn/download ──────────────────────────
// 단일 주문 캐시된 PDF 다운로드 (shop_id 필요 → query param)
router.get('/:orderSn/download', async (req, res) => {
  const { orderSn } = req.params;
  const shopId      = req.query.shop_id;

  if (!shopId) {
    return res.status(400).json({ success: false, error: 'shop_id required' });
  }

  if (!labelStorage.exists(shopId, orderSn)) {
    return res.status(404).json({ success: false, error: '캐시된 PDF가 없습니다.' });
  }

  const buf = labelStorage.load(shopId, orderSn);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${orderSn}.pdf"`);
  res.send(buf);
});

module.exports = router;
