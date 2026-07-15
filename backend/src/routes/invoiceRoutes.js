const express = require('express');
const router = express.Router();
const { getCurrentTenantId } = require('../config/tenant');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const {
  createJob,
  getJob,
  getRunningJob,
  recoverStaleInvoiceJobs,
} = require('../services/jobManager');
const { runInvoice } = require('../jobs/invoiceWorker');
const labelStorage = require('../services/labelStorageService');

router.get('/jobs/:jobId/print', async (req, res) => {
  const jobId = String(req.params.jobId || '').trim();
  const token = String(req.query.token || '').trim();

  const [rows] = await require('../config/database').query(
    `SELECT id, tenant_id, status, result_data
     FROM jobs
     WHERE id = ?
       AND job_type = 'invoice'
     LIMIT 1`,
    [jobId]
  );

  const job = rows[0];
  if (!job) {
    return res.status(404).send('Invoice job not found');
  }

  const expectedToken = getInvoicePrintToken(job.id, job.tenant_id);
  if (!token || token !== expectedToken) {
    return res.status(401).send('Invalid invoice print token');
  }

  const resultData = parseJobResultData(job);
  const mergedPath = resultData?.merged_pdf_path;

  if (job.status !== 'completed' || !mergedPath || !fs.existsSync(mergedPath)) {
    return res.status(404).send('Invoice PDF is not ready');
  }

  const pdfUrl = `/api/invoices/jobs/${encodeURIComponent(job.id)}/print-pdf?token=${encodeURIComponent(expectedToken)}`;
  return res.redirect(302, pdfUrl);
});

router.get('/jobs/:jobId/print-pdf', async (req, res) => {
  const jobId = String(req.params.jobId || '').trim();
  const token = String(req.query.token || '').trim();

  const [rows] = await require('../config/database').query(
    `SELECT id, tenant_id, status, result_data
     FROM jobs
     WHERE id = ?
       AND job_type = 'invoice'
     LIMIT 1`,
    [jobId]
  );

  const job = rows[0];
  if (!job) {
    return res.status(404).send('Invoice job not found');
  }

  const expectedToken = getInvoicePrintToken(job.id, job.tenant_id);
  if (!token || token !== expectedToken) {
    return res.status(401).send('Invalid invoice print token');
  }

  const resultData = parseJobResultData(job);
  const mergedPath = resultData?.merged_pdf_path;

  if (job.status !== 'completed' || !mergedPath || !fs.existsSync(mergedPath)) {
    return res.status(404).send('Invoice PDF is not ready');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="invoice-${job.id}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(mergedPath);
});

router.use(requireAuth);
router.use(requireApprovedTenant);

function getInvoicePrintToken(jobId, tenantId) {
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || process.env.SHOPEE_PARTNER_KEY || 'invoice-print-secret';
  return crypto
    .createHmac('sha256', secret)
    .update(`${tenantId}:${jobId}`)
    .digest('hex')
    .slice(0, 32);
}

function normalizeOrderSnList(body = {}) {
  const rawList = body.order_sns || body.order_sn_list || body.orderSnList || [];
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map(item => (typeof item === 'string' ? item : item?.order_sn || item?.orderSn || ''))
    .map(orderSn => String(orderSn || '').trim())
    .filter(Boolean);
}

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

function getInvoiceErrors(job) {
  const resultData = parseJobResultData(job);
  const results = Array.isArray(resultData?.results) ? resultData.results : [];
  return results
    .filter(item => item.status === 'error')
    .map(item => ({
      order_sn: item.order_sn,
      shop_id: item.shop_id || item.shopId || null,
      message: normalizeInvoiceFailureMessage(item.reason || item.message || item.error || ''),
      detail: item.reason || item.message || item.error || '',
      code: item.code || item.status,
    }));
}

function getInvoiceWaitingItems(job) {
  const resultData = parseJobResultData(job);
  const results = Array.isArray(resultData?.results) ? resultData.results : [];
  return results
    .filter(item => item.status === 'waiting_label' || item.status === 'waiting_document')
    .map(item => ({
      order_sn: item.order_sn,
      shop_id: item.shop_id || item.shopId || null,
      message: '송장 생성 대기 중입니다. 잠시 후 다시 송장출력을 눌러 다운로드하세요.',
      detail: item.reason || item.message || '',
      code: item.status,
    }));
}

function formatInvoiceJob(job) {
  const resultData = parseJobResultData(job) || {};
  const results = Array.isArray(resultData.results) ? resultData.results : [];
  const errors = getInvoiceErrors(job);
  const waiting_items = getInvoiceWaitingItems(job);
  const total = Number(job.progress_total || resultData.total || results.length || 0);
  const processed = Number(job.progress_current || results.length || 0);
  const successCount = Number(resultData.success || results.filter(item => item.status === 'success').length || 0);
  const waitingCount = Number(resultData.waiting || waiting_items.length || 0);
  const failedCount = Number(resultData.error || 0);
  const hasDownload = Boolean(resultData.merged_pdf_path);
  const dbStatus = String(job.status || '').toLowerCase();
  let status = dbStatus === 'pending' ? 'queued' : dbStatus;

  if (dbStatus === 'completed' && errors.length > 0) {
    status = successCount > 0 || waitingCount > 0 ? 'partial_failed' : 'failed';
  }

  return {
    jobId: job.id,
    id: job.id,
    status,
    db_status: job.status,
    total,
    completed: processed,
    failed: failedCount || errors.length,
    waiting: waitingCount,
    current_order_sn: extractCurrentOrderSn(job.progress_message),
    message: job.progress_message || '',
    percent: total > 0 ? Math.round((processed / total) * 100) : 0,
    download_url: hasDownload ? `/api/invoices/jobs/${job.id}/download` : null,
    print_url: hasDownload ? `/api/invoices/jobs/${job.id}/print?token=${getInvoicePrintToken(job.id, job.tenant_id)}` : null,
    legacy_download_url: hasDownload ? `/api/invoice/download/${job.id}` : null,
    results,
    errors,
    waiting_items,
    error_message: normalizeInvoiceFailureMessage(job.error_message || ''),
    detail: job.error_message || '',
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function extractCurrentOrderSn(message) {
  const match = String(message || '').match(/(26[0-9A-Z]+)/);
  return match ? match[1] : null;
}

async function startInvoiceJob(req, res, { legacy = false } = {}) {
  const tenantId = getCurrentTenantId(req);
  const orderSnList = normalizeOrderSnList(req.body);

  if (orderSnList.length === 0) {
    return res.status(400).json({ success: false, error: '주문 목록이 비어있습니다.' });
  }

  if (orderSnList.length > 50) {
    return res.status(400).json({ success: false, error: '한 번에 최대 50건까지 가능합니다.' });
  }

  await recoverStaleInvoiceJobs({ zeroProgressMinutes: 3, staleMinutes: 10, tenantId });

  const running = await getRunningJob('invoice', { tenantId });
  if (running) {
    const runningJob = formatInvoiceJob(running);
    return res.status(409).json({
      success: false,
      code: 'ALREADY_RUNNING',
      error: 'ALREADY_RUNNING',
      message: '이미 송장 생성 작업이 진행 중입니다.',
      jobId: running.id,
      job_id: running.id,
      job: runningJob,
    });
  }

  const jobId = await createJob('invoice', { tenantId });

  runInvoice(jobId, orderSnList, { tenantId }).catch(err => {
    console.error('[InvoiceRoute] Unhandled error:', err.message);
  });

  return res.json({
    success: true,
    jobId,
    job_id: jobId,
    message: legacy
      ? `송장출력 시작: ${orderSnList.length}건`
      : '송장 생성 작업을 시작했습니다.',
  });
}

async function sendInvoiceJobDownload(req, res, jobId) {
  const tenantId = getCurrentTenantId(req);
  const job = await getJob(jobId, { tenantId });

  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  const resultData = parseJobResultData(job);
  const mergedPath = resultData?.merged_pdf_path;
  if (job.status !== 'completed' || !mergedPath || !fs.existsSync(mergedPath)) {
    const detail = getInvoiceFailureDetail(job);
    return res.status(job.status === 'completed' ? 404 : 400).json({
      success: false,
      error: normalizeInvoiceFailureMessage(detail || '송장 PDF가 아직 준비되지 않았습니다.'),
      detail,
      job: formatInvoiceJob(job),
    });
  }

  const fileName = `invoices_${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(mergedPath);
}



router.post('/jobs', async (req, res) => {
  return startInvoiceJob(req, res);
});

router.get('/jobs/:jobId', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const job = await getJob(req.params.jobId, { tenantId });
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  return res.json({
    success: true,
    job: formatInvoiceJob(job),
  });
});

router.get('/jobs/:jobId/download', async (req, res) => {
  return sendInvoiceJobDownload(req, res, req.params.jobId);
});

router.post('/start', async (req, res) => {
  return startInvoiceJob(req, res, { legacy: true });
});

router.get('/download/:jobId', async (req, res) => {
  return sendInvoiceJobDownload(req, res, req.params.jobId);
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
