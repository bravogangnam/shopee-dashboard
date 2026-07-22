const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const STORAGE_ROOT = path.join(__dirname, '../../storage/brand-backgrounds');
const METADATA_FILE = 'backgrounds.json';

function tenantDirectory(tenantId) {
  const safeTenantId = Number.parseInt(tenantId, 10);
  if (!Number.isSafeInteger(safeTenantId) || safeTenantId <= 0) throw new Error('Invalid tenant id');
  return path.join(STORAGE_ROOT, String(safeTenantId));
}

async function readMetadata(tenantId) {
  const directory = tenantDirectory(tenantId);
  try {
    const raw = await fs.readFile(path.join(directory, METADATA_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeMetadata(tenantId, rows) {
  const directory = tenantDirectory(tenantId);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, METADATA_FILE);
  const temporary = path.join(directory, `${METADATA_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(rows, null, 2), 'utf8');
  await fs.rename(temporary, target);
}

function publicRow(row) {
  return {
    id: row.id,
    name: row.name,
    isDefault: Boolean(row.isDefault),
    width: 1000,
    height: 1000,
    createdAt: row.createdAt,
    url: `/api/brand-image-maker/backgrounds/${encodeURIComponent(row.id)}/file`,
  };
}

async function listBackgrounds(tenantId) {
  return (await readMetadata(tenantId)).map(publicRow);
}

async function addBackgrounds(tenantId, files) {
  const directory = tenantDirectory(tenantId);
  await fs.mkdir(directory, { recursive: true });
  const rows = await readMetadata(tenantId);
  const added = [];

  for (const file of files) {
    const metadata = await sharp(file.buffer, { failOn: 'error' }).metadata();
    if (metadata.format !== 'png') {
      const error = new Error(`${file.originalname}: PNG 파일만 등록할 수 있습니다.`);
      error.status = 415;
      throw error;
    }
    const id = crypto.randomUUID();
    const filename = `${id}.png`;
    await sharp(file.buffer)
      .resize(1000, 1000, { fit: 'cover', position: 'centre' })
      .png({ compressionLevel: 9 })
      .toFile(path.join(directory, filename));
    const baseName = path.basename(file.originalname, path.extname(file.originalname)).trim().slice(0, 80);
    const row = {
      id,
      filename,
      name: baseName || `배경 ${rows.length + added.length + 1}`,
      isDefault: rows.length === 0 && added.length === 0,
      createdAt: new Date().toISOString(),
    };
    rows.push(row);
    added.push(publicRow(row));
  }
  await writeMetadata(tenantId, rows);
  return added;
}

async function updateBackground(tenantId, id, patch) {
  const rows = await readMetadata(tenantId);
  const index = rows.findIndex(row => row.id === id);
  if (index < 0) return null;
  if (typeof patch.name === 'string') {
    const name = patch.name.trim().slice(0, 80);
    if (!name) throw new Error('배경 이름을 입력하세요.');
    rows[index].name = name;
  }
  if (patch.isDefault === true) rows.forEach(row => { row.isDefault = row.id === id; });
  await writeMetadata(tenantId, rows);
  return publicRow(rows[index]);
}

async function deleteBackground(tenantId, id) {
  const rows = await readMetadata(tenantId);
  const index = rows.findIndex(row => row.id === id);
  if (index < 0) return false;
  const [removed] = rows.splice(index, 1);
  if (removed.isDefault && rows.length) rows[0].isDefault = true;
  await fs.rm(path.join(tenantDirectory(tenantId), removed.filename), { force: true });
  await writeMetadata(tenantId, rows);
  return true;
}

async function getBackgroundFile(tenantId, id) {
  const row = (await readMetadata(tenantId)).find(item => item.id === id);
  if (!row) return null;
  return path.join(tenantDirectory(tenantId), row.filename);
}

async function deleteTenantBackgrounds(tenantId) {
  await fs.rm(tenantDirectory(tenantId), { recursive: true, force: true });
}

module.exports = { addBackgrounds, deleteBackground, deleteTenantBackgrounds, getBackgroundFile, listBackgrounds, updateBackground };
