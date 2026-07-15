const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const labelStorage = require('./labelStorageService');

const DEFAULT_RETENTION_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
const MERGED_DIR_NAME = '_merged';

let scheduled = false;

function getRetentionDays(value = process.env.SHIPPING_LABEL_RETENTION_DAYS) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

async function statSafe(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function unlinkPdf(filePath, result, bucket) {
  try {
    await fs.promises.unlink(filePath);
    result.deletedFiles += 1;
    result.deletedBytes += bucket.size || 0;
    bucket.deleted += 1;
    bucket.deletedBytes += bucket.size || 0;
    result.files.push({ path: filePath, size: bucket.size || 0, reason: bucket.reason });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    result.failedFiles += 1;
    result.errors.push({ path: filePath, reason: bucket.reason, error: err.message });
  }
}

async function cleanupMergedLabels(baseDir, result) {
  const merged = { scanned: 0, deleted: 0, deletedBytes: 0, size: 0, reason: 'merged' };
  result.merged = merged;
  const mergedDir = path.join(baseDir, MERGED_DIR_NAME);
  const stat = await statSafe(mergedDir);
  if (!stat || !stat.isDirectory()) return;

  const entries = await fs.promises.readdir(mergedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
    const filePath = path.join(mergedDir, entry.name);
    const fileStat = await statSafe(filePath);
    if (!fileStat || !fileStat.isFile()) continue;
    merged.scanned += 1;
    merged.size = fileStat.size;
    await unlinkPdf(filePath, result, merged);
  }
}

async function cleanupExpiredIndividualLabels(baseDir, cutoffMs, result) {
  const individual = { scanned: 0, deleted: 0, deletedBytes: 0, size: 0, reason: 'older_than_retention' };
  result.individual = individual;
  const stat = await statSafe(baseDir);
  if (!stat || !stat.isDirectory()) return;

  const shopDirs = await fs.promises.readdir(baseDir, { withFileTypes: true });
  for (const shopDir of shopDirs) {
    if (!shopDir.isDirectory() || shopDir.name === MERGED_DIR_NAME) continue;
    const dirPath = path.join(baseDir, shopDir.name);
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
      const filePath = path.join(dirPath, entry.name);
      const fileStat = await statSafe(filePath);
      if (!fileStat || !fileStat.isFile()) continue;
      individual.scanned += 1;
      if (fileStat.mtimeMs > cutoffMs) continue;
      individual.size = fileStat.size;
      await unlinkPdf(filePath, result, individual);
    }
  }
}

async function cleanupShippingLabelFiles({ retentionDays = getRetentionDays(), now = new Date(), baseDir = labelStorage.BASE_DIR } = {}) {
  const safeRetentionDays = getRetentionDays(retentionDays);
  const cutoff = new Date(now.getTime() - safeRetentionDays * DAY_MS);
  const result = {
    success: true,
    retentionDays: safeRetentionDays,
    cutoffAt: cutoff.toISOString(),
    baseDir,
    deletedFiles: 0,
    deletedBytes: 0,
    failedFiles: 0,
    files: [],
    errors: [],
    note: 'Only invoice PDF files are deleted; orders, order_items, FIFO, inventory, and settlement data are not modified.',
  };

  await fs.promises.mkdir(baseDir, { recursive: true });
  await cleanupMergedLabels(baseDir, result);
  await cleanupExpiredIndividualLabels(baseDir, cutoff.getTime(), result);
  result.success = result.failedFiles === 0;
  return result;
}

function startShippingLabelCleanupJob() {
  if (scheduled) return;
  scheduled = true;
  cron.schedule('17 3 * * *', () => {
    cleanupShippingLabelFiles()
      .then(result => {
        console.log(`[ShippingLabelCleanup] deleted=${result.deletedFiles}, failed=${result.failedFiles}, retentionDays=${result.retentionDays}`);
      })
      .catch(err => {
        console.error('[ShippingLabelCleanup] failed:', err.message);
      });
  }, { scheduled: true, timezone: process.env.TZ || 'Etc/UTC' });
  console.log(`[ShippingLabelCleanup] scheduled daily (retentionDays=${getRetentionDays()})`);
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  getRetentionDays,
  cleanupShippingLabelFiles,
  startShippingLabelCleanupJob,
};
