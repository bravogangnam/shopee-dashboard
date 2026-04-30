const express = require('express');
const router = express.Router();
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { createJob, getJob, getRunningJob } = require('../services/jobManager');
const { runInvoice } = require('../jobs/invoiceWorker');
const labelStorage = require('../services/labelStorageService');

router.use(requireAuth);

function parseJobResultData(job) {
  if (!job?.result_data) return null;
  if (typeof job.result_data === 'string') {
    try {
      return JSON.parse(job.result_data);
    } catch (err) {
      return null;
    }
  }
  return job.result_data;
}

function normalizeInvoiceFailureMessage(message) {
  const text = String(message || '');
  if (
    /Shipping parameters can only be obtained when package is ready to be shipped/i.test(text) ||
    /buyer TW KYC/i.test(text) ||
    /\bKYC\b/i.test(text) ||
    /package is ready to be shipped/i.test(text)
  ) {
    return '대만 KYC 승인 대기 또는 송장 준비 전 주문입니다. 구매자 인증/배송 준비 완료 후 다시 시도하세요.';
  }
  if (/PDF|file|파일|not found|not ready/i.test(text)) {
    return '송장 PDF가 아직 준비되지 않았습니다. 잠시 후 주문 동기화 후 다시 시도하세요.';
  }
  return text || '송장 출력에 실패했습니다.';
}

function getInvoiceFailureDetail(job) {
  const resultData = parseJobResultData(job);
  const results = Array.isArray(resultData?.results) ? resultData.results : [];
  const failed = results.find(item => item.status === 'error') || results.find(item => item.status === 'skipped');
  return failed?.reason || job?.error_message || job?.progress_message || '';
}

router.post('/start', async (req, res) => {
  const { order_sn_list } = req.body;

  if (!Array.isArray(order_sn_list) || order_sn_list.length === 0) {
    return res.status(400).json({ success: false, error: '주문 목록이 비어있습니다.' });
  }

  if (order_sn_list.length > 50) {
    return res.status(400).json({ success: false, error: '한 번에 최대 50건까지 가능합니다.' });
  }

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

  runInvoice(jobId, order_sn_list).catch(err => {
    console.error('[InvoiceRoute] Unhandled error:', err.message);
  });

  return res.json({
    success: true,
    job_id: jobId,
    message: `송장출력 시작: ${order_sn_list.length}건`,
  });
});

router.get('/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = await getJob(jobId);

  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  if (job.status !== 'completed') {
    const detail = getInvoiceFailureDetail(job);
    return res.status(400).json({
      success: false,
      error: normalizeInvoiceFailureMessage(detail || `Job status: ${job.status}`),
      detail,
    });
  }

  const resultData = parseJobResultData(job);
  const mergedPath = resultData?.merged_pdf_path;
  if (!mergedPath || !fs.existsSync(mergedPath)) {
    const detail = getInvoiceFailureDetail(job);
    return res.status(404).json({
      success: false,
      error: normalizeInvoiceFailureMessage(detail || 'PDF file not found'),
      detail,
    });
  }

  const fileName = `invoices_${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  fs.createReadStream(mergedPath).pipe(res);
});

router.get('/:orderSn/download', async (req, res) => {
  const { orderSn } = req.params;
  const shopId = req.query.shop_id;

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
