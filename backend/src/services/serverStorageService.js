const fs = require('fs');
const path = require('path');
const labelStorage = require('./labelStorageService');
const { cleanupShippingLabelFiles, getRetentionDays } = require('./shippingLabelCleanupService');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
const BACKEND_LOG_DIR = path.join(PROJECT_ROOT, 'backend', 'logs');
const BACKUP_PREFIX = 'build-backup-deploy-';
const BACKUPS_TO_KEEP = 3;
const SAFE_LOG_NAMES = new Set(['pm2.log', 'pm2-error.log']);

async function statSafe(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isDirectChild(parentPath, childPath) {
  return path.dirname(path.resolve(childPath)) === path.resolve(parentPath);
}

async function directorySize(dirPath) {
  const stat = await statSafe(dirPath);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) total += (await statSafe(entryPath))?.size || 0;
  }
  return total;
}

async function listOldFrontendBackups() {
  const frontendStat = await statSafe(FRONTEND_DIR);
  if (!frontendStat?.isDirectory()) return [];

  const entries = await fs.promises.readdir(FRONTEND_DIR, { withFileTypes: true });
  const backups = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX))
    .sort((a, b) => b.name.localeCompare(a.name));

  const oldBackups = backups.slice(BACKUPS_TO_KEEP);
  return Promise.all(oldBackups.map(async entry => {
    const backupPath = path.join(FRONTEND_DIR, entry.name);
    return { path: backupPath, name: entry.name, bytes: await directorySize(backupPath) };
  }));
}

async function listSafeLogs() {
  const logStat = await statSafe(BACKEND_LOG_DIR);
  if (!logStat?.isDirectory()) return [];

  const entries = await fs.promises.readdir(BACKEND_LOG_DIR, { withFileTypes: true });
  const logs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !SAFE_LOG_NAMES.has(entry.name)) continue;
    const logPath = path.join(BACKEND_LOG_DIR, entry.name);
    const stat = await statSafe(logPath);
    if (stat) logs.push({ path: logPath, name: entry.name, bytes: stat.size });
  }
  return logs;
}

async function estimateExpiredLabels({ now = new Date(), retentionDays = getRetentionDays() } = {}) {
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let files = 0;
  let bytes = 0;
  const baseStat = await statSafe(labelStorage.BASE_DIR);
  if (!baseStat?.isDirectory()) return { files, bytes };

  const shopDirs = await fs.promises.readdir(labelStorage.BASE_DIR, { withFileTypes: true });
  for (const shopDir of shopDirs) {
    if (!shopDir.isDirectory()) continue;
    const dirPath = path.join(labelStorage.BASE_DIR, shopDir.name);
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
      const fileStat = await statSafe(path.join(dirPath, entry.name));
      const isMerged = shopDir.name === '_merged';
      if (fileStat && (isMerged || fileStat.mtimeMs <= cutoffMs)) {
        files += 1;
        bytes += fileStat.size;
      }
    }
  }
  return { files, bytes };
}

async function getServerStorageStatus() {
  const volume = await fs.promises.statfs(PROJECT_ROOT);
  const blockSize = Number(volume.bsize || volume.frsize || 0);
  const totalBytes = Number(volume.blocks) * blockSize;
  const availableBytes = Number(volume.bavail) * blockSize;
  const freeBytes = Number(volume.bfree) * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);

  const [labels, backups, logs] = await Promise.all([
    estimateExpiredLabels(),
    listOldFrontendBackups(),
    listSafeLogs(),
  ]);
  const backupBytes = backups.reduce((sum, item) => sum + item.bytes, 0);
  const logBytes = logs.reduce((sum, item) => sum + item.bytes, 0);

  return {
    volume: {
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    },
    cleanup: {
      reclaimableBytes: labels.bytes + backupBytes + logBytes,
      labels,
      frontendBackups: { count: backups.length, bytes: backupBytes },
      logs: { count: logs.filter(item => item.bytes > 0).length, bytes: logBytes },
    },
    policy: {
      shippingLabelRetentionDays: getRetentionDays(),
      frontendBackupsToKeep: BACKUPS_TO_KEEP,
    },
  };
}

async function cleanupSafeServerFiles() {
  const before = await getServerStorageStatus();
  const labels = await cleanupShippingLabelFiles();
  const backups = await listOldFrontendBackups();
  const logs = await listSafeLogs();
  let deletedBackupBytes = 0;
  let clearedLogBytes = 0;

  for (const backup of backups) {
    if (!backup.name.startsWith(BACKUP_PREFIX) || !isDirectChild(FRONTEND_DIR, backup.path)) continue;
    await fs.promises.rm(backup.path, { recursive: true, force: false });
    deletedBackupBytes += backup.bytes;
  }

  for (const log of logs) {
    if (!SAFE_LOG_NAMES.has(log.name) || !isDirectChild(BACKEND_LOG_DIR, log.path)) continue;
    await fs.promises.truncate(log.path, 0);
    clearedLogBytes += log.bytes;
  }

  const after = await getServerStorageStatus();
  return {
    success: labels.failedFiles === 0,
    before,
    after,
    deletedBytes: labels.deletedBytes + deletedBackupBytes + clearedLogBytes,
    details: {
      shippingLabels: { deletedFiles: labels.deletedFiles, deletedBytes: labels.deletedBytes, failedFiles: labels.failedFiles },
      frontendBackups: { deleted: backups.length, deletedBytes: deletedBackupBytes, kept: BACKUPS_TO_KEEP },
      logs: { cleared: logs.filter(item => item.bytes > 0).length, clearedBytes: clearedLogBytes },
    },
  };
}

module.exports = {
  BACKUPS_TO_KEEP,
  getServerStorageStatus,
  cleanupSafeServerFiles,
};
