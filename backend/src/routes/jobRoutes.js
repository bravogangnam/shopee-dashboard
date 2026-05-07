/**
 * Job 관련 라우트
 * POST /api/jobs/backfill        - 백필 시작
 * POST /api/jobs/sync            - 수동 동기화 시작
 * GET  /api/jobs/:id/status      - Job 상태 조회 (폴링용)
 * GET  /api/jobs/active          - 진행 중인 Job 목록
 * GET  /api/jobs/recent          - 최근 완료 Job 목록
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  createJob,
  getJob,
  getRunningJob,
  markStaleJobsFailed,
} = require('../services/jobManager');
const { runBackfill } = require('../jobs/backfillWorker');
const { runSync } = require('../jobs/syncWorker');
const db = require('../config/database');
const { CURRENT_TENANT_ID } = require('../config/tenant');

router.use(requireAuth);

// ─── 백필 시작 ─────────────────────────────────────────────────
router.post('/backfill', async (req, res) => {
  // 중복 실행 방지
  const running = await getRunningJob('backfill');
  if (running) {
    return res.status(409).json({
      success: false,
      error: 'ALREADY_RUNNING',
      message: '백필이 이미 진행 중입니다',
      job_id: running.id,
    });
  }

  const jobId = await createJob('backfill');

  // 백그라운드 실행 (await 없이)
  runBackfill(jobId).catch(err => {
    console.error('[BackfillRoute] Unhandled error:', err.message);
  });

  return res.json({
    success: true,
    job_id: jobId,
    message: '백필을 시작합니다 (2026-01-01 ~ 현재)',
  });
});

// ─── 수동 동기화 시작 ───────────────────────────────────────────
router.post('/sync', async (req, res) => {
  // 중복 실행 방지 (sync, backfill 둘 다 체크)
  const runningSync = await getRunningJob('sync');
  if (runningSync) {
    return res.status(409).json({
      success: false,
      error: 'ALREADY_RUNNING',
      message: '동기화가 이미 진행 중입니다',
      job_id: runningSync.id,
    });
  }
  const runningBackfill = await getRunningJob('backfill');
  if (runningBackfill) {
    return res.status(409).json({
      success: false,
      error: 'ALREADY_RUNNING',
      message: '백필이 진행 중입니다. 완료 후 동기화를 시작하세요.',
      job_id: runningBackfill.id,
    });
  }

  const jobId = await createJob('sync');

  runSync(jobId).catch(err => {
    console.error('[SyncRoute] Unhandled error:', err.message);
  });

  return res.json({
    success: true,
    job_id: jobId,
    message: '동기화를 시작합니다',
  });
});

// ─── Job 상태 조회 (폴링) ──────────────────────────────────────
router.get('/:id/status', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  return res.json({
    success: true,
    job: {
      id: job.id,
      job_type: job.job_type,
      status: job.status,
      progress_total: job.progress_total,
      progress_current: job.progress_current,
      progress_message: job.progress_message,
      result_data: job.result_data,
      error_message: job.error_message,
      created_at: job.created_at,
      updated_at: job.updated_at,
      // 진행률 퍼센트
      percent: job.progress_total > 0
        ? Math.round((job.progress_current / job.progress_total) * 100)
        : 0,
    },
  });
});

// ─── 진행 중인 Job 목록 ────────────────────────────────────────
// 조회 전 5분 초과 job을 먼저 failed 처리 → 폴러가 즉시 완료 감지
router.get('/active', async (req, res) => {
  const tenantId = CURRENT_TENANT_ID;
  await markStaleJobsFailed({ tenantId });
  const [rows] = await db.query(
    `SELECT id, tenant_id, job_type, status, progress_total, progress_current, progress_message, created_at, updated_at
     FROM jobs
     WHERE tenant_id = ?
       AND status IN ('pending','running')
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return res.json({ success: true, jobs: rows });
});

// ─── 최근 완료 Job 목록 ────────────────────────────────────────
router.get('/recent', async (req, res) => {
  const tenantId = CURRENT_TENANT_ID;
  const [rows] = await db.query(
    `SELECT id, tenant_id, job_type, status, progress_total, progress_current,
            progress_message, result_data, error_message, created_at, updated_at
     FROM jobs
     WHERE tenant_id = ?
     ORDER BY created_at DESC LIMIT 20`,
    [tenantId]
  );
  return res.json({ success: true, jobs: rows });
});

module.exports = router;
