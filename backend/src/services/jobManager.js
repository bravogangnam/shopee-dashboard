/**
 * Job Manager
 * - 백그라운드 작업 생성/추적
 * - DB jobs 테이블 기반 상태 관리
 * - 중복 실행 방지
 * - 진행 상태 폴링용 API 지원
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

/**
 * 새 Job 생성
 * @param {string} job_type - 'sync' | 'backfill' | 'invoice'
 * @returns {string} job_id (UUID)
 */
async function createJob(job_type) {
  const id = uuidv4();
  await db.query(
    `INSERT INTO jobs (id, job_type, status, progress_total, progress_current, progress_message)
     VALUES (?, ?, 'pending', 0, 0, '작업 대기 중...')`,
    [id, job_type]
  );
  return id;
}

/**
 * Job 상태 조회
 */
async function getJob(job_id) {
  const [rows] = await db.query('SELECT * FROM jobs WHERE id = ?', [job_id]);
  return rows[0] || null;
}

/**
 * 진행 중인 동일 타입 Job 확인 (중복 방지)
 */
async function getRunningJob(job_type) {
  const [rows] = await db.query(
    `SELECT * FROM jobs WHERE job_type = ? AND status IN ('pending','running')
     ORDER BY created_at DESC LIMIT 1`,
    [job_type]
  );
  return rows[0] || null;
}

/**
 * Job 상태를 running으로 변경
 */
async function startJob(job_id, total = 0) {
  await db.query(
    `UPDATE jobs SET status='running', progress_total=?, progress_current=0,
     progress_message='작업 시작 중...', updated_at=NOW() WHERE id=?`,
    [total, job_id]
  );
}

/**
 * Job 진행률 업데이트
 * @param {string} job_id
 * @param {number} current
 * @param {number} total
 * @param {string} message
 */
async function updateProgress(job_id, current, total, message) {
  await db.query(
    `UPDATE jobs SET progress_current=?, progress_total=?, progress_message=?, updated_at=NOW()
     WHERE id=?`,
    [current, total, message, job_id]
  );
}

/**
 * Job 중간 결과 업데이트
 * - 긴 작업에서 프론트가 실패/성공 상세를 폴링으로 확인할 수 있게 한다.
 */
async function updateJobResult(job_id, result_data = {}) {
  await db.query(
    `UPDATE jobs SET result_data=?, updated_at=NOW() WHERE id=?`,
    [JSON.stringify(result_data), job_id]
  );
}

/**
 * Job 완료
 * @param {string} job_id
 * @param {object} result_data - 결과 JSON
 */
async function completeJob(job_id, result_data = {}) {
  await db.query(
    `UPDATE jobs SET status='completed', progress_message='완료',
     result_data=?, updated_at=NOW() WHERE id=?`,
    [JSON.stringify(result_data), job_id]
  );
}

/**
 * Job 실패
 * @param {string} job_id
 * @param {string} error_message
 */
async function failJob(job_id, error_message) {
  await db.query(
    `UPDATE jobs SET status='failed', error_message=?, progress_message='오류 발생',
     updated_at=NOW() WHERE id=?`,
    [error_message, job_id]
  );
}

/**
 * 오래된 pending/running invoice Job 자동 복구
 * - Shopee 처리는 끝났지만 finalization 실패 등으로 running에 남은 송장 job을 해제한다.
 */
async function recoverStaleInvoiceJobs({ staleMinutes = 10 } = {}) {
  const [result] = await db.query(
    `UPDATE jobs
     SET status='failed',
         error_message=COALESCE(error_message, 'auto recovery: invoice job stale running'),
         progress_message='자동 복구됨: 오래된 송장 작업 해제',
         updated_at=NOW()
     WHERE job_type='invoice'
       AND status IN ('pending','running')
       AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [staleMinutes]
  );
  if (result.affectedRows > 0) {
    console.log(`[JobManager] Recovered ${result.affectedRows} stale invoice job(s) (>${staleMinutes}min)`);
  }
  return result.affectedRows;
}

/**
 * 오래된 완료/실패 Job 정리 (7일 이상)
 */
async function cleanOldJobs() {
  await db.query(
    `DELETE FROM jobs WHERE status IN ('completed','failed')
     AND updated_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`
  );
}

/**
 * 비정상 종료된 running Job을 failed로 복구
 * (서버 재시작 시 호출)
 */
async function recoverStaleJobs() {
  const [result] = await db.query(
    `UPDATE jobs SET status='failed', error_message='서버 재시작으로 인해 중단됨',
     updated_at=NOW()
     WHERE status IN ('pending','running')
     AND updated_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)`
  );
  if (result.affectedRows > 0) {
    console.log(`[JobManager] Recovered ${result.affectedRows} stale jobs`);
  }
}

/**
 * 5분 이상 running 상태인 Job을 failed로 처리 (타임아웃)
 * - autoSyncJob / syncRoute 등에서 주기적으로 호출
 */
async function markStaleJobsFailed() {
  const [result] = await db.query(
    `UPDATE jobs SET status='failed',
       error_message='동기화 시간 초과 (5분)',
       progress_message='시간 초과로 종료됨',
       updated_at=NOW()
     WHERE status IN ('pending','running')
       AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`
  );
  if (result.affectedRows > 0) {
    console.log(`[JobManager] Timed out ${result.affectedRows} stale job(s) (>5min)`);
  }
  return result.affectedRows;
}

module.exports = {
  createJob,
  getJob,
  getRunningJob,
  startJob,
  updateProgress,
  updateJobResult,
  completeJob,
  failJob,
  recoverStaleInvoiceJobs,
  cleanOldJobs,
  recoverStaleJobs,
  markStaleJobsFailed,
};
