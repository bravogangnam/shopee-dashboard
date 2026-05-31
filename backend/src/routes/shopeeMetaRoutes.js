const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const {
  sanitizeObjectForMetaResponse,
  getShopeeMetaStatus,
  recommendCategory,
  fetchCategories,
  fetchAttributes,
  fetchBrands,
  autoMetadataBatchDisabled,
  krscPrepare,
} = require('../services/shopeeMetaService');

const router = express.Router();

router.get('/mass-upload/images/public/:tenantFolder/:jobId/:fileName', async (req, res) => {
  const tenantFolder = String(req.params?.tenantFolder || '');
  const jobId = safeName(req.params?.jobId || '');
  const fileName = safeName(req.params?.fileName || '');

  if (!safeTenantFolder(tenantFolder)) {
    return res.status(400).json({ ok: false, error: 'INVALID_TENANT_FOLDER' });
  }

  if (!jobId || !safeImageExt(fileName)) {
    return res.status(400).json({ ok: false, error: 'INVALID_FILE_NAME' });
  }

  const root = path.resolve(IMAGE_ROOT, tenantFolder, jobId);
  const filePath = path.resolve(root, fileName);

  if (!filePath.startsWith(`${root}${path.sep}`)) {
    return res.status(400).json({ ok: false, error: 'INVALID_PATH' });
  }

  res.type(imageContentType(fileName));
  return res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ ok: false, error: 'IMAGE_NOT_FOUND' });
    }
  });
});

router.use(requireAuth);
router.use(requireApprovedTenant);

const getTenantId = (req) => req?.tenantId ?? req?.user?.tenant_id ?? req?.user?.tenantId ?? null;

const TEMPLATE_ROOT = path.join(process.cwd(), 'storage', 'krsc-templates');
const SHARED_TEMPLATE_ROOT = path.join(TEMPLATE_ROOT, 'shared');
const MAX_TEMPLATE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_FILES = 200;
const GENERATED_ROOT = path.join(process.cwd(), 'storage', 'krsc-generated');
const IMAGE_ROOT = path.join(process.cwd(), 'storage', 'mass-upload-images');
const REQUIRED_VALUES_ROOT = path.join(process.cwd(), 'storage', 'krsc-required-values');
const CATEGORY_CATALOG_ROOT = path.join(process.cwd(), 'storage', 'krsc-category-catalog');
let KRSC_CATEGORY_CATALOG_SEED = [];
try {
  // Code-owned KRSC/CNSC global category seed. Storage catalog is only for additions/overrides.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  KRSC_CATEGORY_CATALOG_SEED = require('../data/krscCategoryCatalogSeed.json');
} catch {
  KRSC_CATEGORY_CATALOG_SEED = [];
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function gramsToKgForShopee(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const numeric = Number(raw.replace(/,/g, '').replace(/g$/i, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return raw;

  const kg = numeric / 1000;
  return String(Number(kg.toFixed(3)));
}

function padNo(n) {
  return `P${String(n).padStart(4, '0')}`;
}

function sanitizeCategoryId(input) {
  return String(input || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
}

async function readTemplateDirectory(dir, scope) {
  let entries = [];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const templates = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const metadataPath = path.join(dir, entry.name, 'metadata.json');

      try {
        const raw = await fs.readFile(metadataPath, 'utf8');
        const metadata = JSON.parse(raw);
        return {
          ...metadata,
          scope,
          isShared: scope === 'shared',
        };
      } catch {
        return null;
      }
    })
  );

  return templates.filter(Boolean);
}

async function readTenantTemplates(tenantId) {
  const tenantDir = path.join(TEMPLATE_ROOT, `tenant_${tenantId}`);

  const sharedTemplates = await readTemplateDirectory(SHARED_TEMPLATE_ROOT, 'shared');
  const tenantTemplates = await readTemplateDirectory(tenantDir, 'tenant');

  const byCategory = new Map();

  // shared 먼저 넣고, tenant가 있으면 덮어쓰기
  sharedTemplates.forEach((template) => {
    if (template?.categoryId) byCategory.set(String(template.categoryId), template);
  });

  tenantTemplates.forEach((template) => {
    if (template?.categoryId) byCategory.set(String(template.categoryId), template);
  });

  return Array.from(byCategory.values());
}

function getTemplatePathsForCategory({ tenantId, categoryId }) {
  const tenantDir = path.join(TEMPLATE_ROOT, `tenant_${tenantId}`, categoryId);
  const sharedDir = path.join(SHARED_TEMPLATE_ROOT, categoryId);

  return {
    tenant: {
      templatePath: path.join(tenantDir, 'template.xlsx'),
      metadataPath: path.join(tenantDir, 'metadata.json'),
    },
    shared: {
      templatePath: path.join(sharedDir, 'template.xlsx'),
      metadataPath: path.join(sharedDir, 'metadata.json'),
    },
  };
}

async function loadTemplateForCategory({ tenantId, categoryId }) {
  const paths = getTemplatePathsForCategory({ tenantId, categoryId });

  for (const scope of ['tenant', 'shared']) {
    const candidate = paths[scope];

    try {
      const metadata = JSON.parse(await fs.readFile(candidate.metadataPath, 'utf8'));
      await fs.access(candidate.templatePath);

      return {
        scope,
        metadata: {
          ...metadata,
          scope,
          isShared: scope === 'shared',
        },
        templatePath: candidate.templatePath,
      };
    } catch {
      // try next
    }
  }

  return null;
}


function safeImageExt(name) {
  return /\.(jpe?g|png)$/i.test(String(name || ''));
}

function safeTenantFolder(name) {
  return /^tenant_\d+$/.test(String(name || ''));
}

function makeImageJobId() {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)}_${Math.random().toString(36).slice(2, 6)}`;
}

function imageContentType(fileName) {
  return /\.png$/i.test(String(fileName || '')) ? 'image/png' : 'image/jpeg';
}


function pathIsInside(parentDir, candidatePath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function getTenantImageDir(tenantId) {
  const tenantFolder = `tenant_${tenantId}`;
  const root = path.resolve(IMAGE_ROOT);
  const tenantDir = path.resolve(root, tenantFolder);

  if (!pathIsInside(root, tenantDir)) {
    throw new Error('INVALID_TENANT_IMAGE_PATH');
  }

  return { tenantFolder, root, tenantDir };
}

function getTenantImageJobDir(tenantId, jobId) {
  const { tenantDir, root } = getTenantImageDir(tenantId);
  const jobDir = path.resolve(tenantDir, jobId);

  if (!pathIsInside(root, jobDir) || !pathIsInside(tenantDir, jobDir) || jobDir === tenantDir) {
    throw new Error('INVALID_IMAGE_JOB_PATH');
  }

  return { tenantDir, jobDir };
}

async function summarizeDirectory(dir) {
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(currentDir) {
    let entries = [];

    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }

    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        return;
      }

      if (!entry.isFile()) return;

      const stat = await fs.stat(entryPath);
      fileCount += 1;
      totalBytes += stat.size;
    }));
  }

  await walk(dir);
  return { fileCount, totalBytes };
}

function timestampMsFromMetadata(metadata, fallbackStat) {
  const uploadedMs = Date.parse(metadata?.uploadedAt || '');
  if (Number.isFinite(uploadedMs)) return uploadedMs;

  const birthMs = fallbackStat?.birthtimeMs;
  if (Number.isFinite(birthMs) && birthMs > 0) return birthMs;

  const modifiedMs = fallbackStat?.mtimeMs;
  if (Number.isFinite(modifiedMs)) return modifiedMs;

  return Date.now();
}

async function readImageJobSummary(tenantDir, entryName) {
  const jobDir = path.resolve(tenantDir, entryName);
  if (!pathIsInside(tenantDir, jobDir) || jobDir === tenantDir) return null;

  let stat;
  try {
    stat = await fs.stat(jobDir);
  } catch {
    return null;
  }

  if (!stat.isDirectory()) return null;

  let metadata = {};
  try {
    const raw = await fs.readFile(path.join(jobDir, 'metadata.json'), 'utf8');
    metadata = JSON.parse(raw);
  } catch {
    metadata = {};
  }

  const { fileCount, totalBytes } = await summarizeDirectory(jobDir);
  const timestampMs = timestampMsFromMetadata(metadata, stat);

  return {
    ...metadata,
    jobId: entryName,
    metadataJobId: metadata?.jobId,
    uploadedAt: metadata?.uploadedAt || new Date(timestampMs).toISOString(),
    fileCount,
    totalBytes,
  };
}

async function readImageJobsForTenant(tenantId) {
  const { tenantDir } = getTenantImageDir(tenantId);
  let entries = [];

  try {
    entries = await fs.readdir(tenantDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const jobs = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => readImageJobSummary(tenantDir, entry.name))
  );

  return jobs.filter(Boolean).sort((a, b) => Date.parse(b.uploadedAt || '') - Date.parse(a.uploadedAt || ''));
}

function summarizeImageJobs(jobs) {
  return jobs.reduce((summary, job) => ({
    jobCount: summary.jobCount + 1,
    fileCount: summary.fileCount + (Number(job?.fileCount) || 0),
    totalBytes: summary.totalBytes + (Number(job?.totalBytes) || 0),
  }), { jobCount: 0, fileCount: 0, totalBytes: 0 });
}


async function readRequiredValuesDirectory(dir, scope) {
  let entries = [];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const rows = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const valuesPath = path.join(dir, entry.name, 'values.json');

      try {
        const raw = await fs.readFile(valuesPath, 'utf8');
        const data = JSON.parse(raw);
        return {
          ...data,
          scope,
          isShared: scope === 'shared',
        };
      } catch {
        return null;
      }
    })
  );

  return rows.filter(Boolean);
}

async function readRequiredValuesForTenant(tenantId) {
  const sharedDir = path.join(REQUIRED_VALUES_ROOT, 'shared');
  const tenantDir = path.join(REQUIRED_VALUES_ROOT, `tenant_${tenantId}`);

  const sharedRows = await readRequiredValuesDirectory(sharedDir, 'shared');
  const tenantRows = await readRequiredValuesDirectory(tenantDir, 'tenant');

  const byCategory = new Map();

  sharedRows.forEach((row) => {
    if (row?.categoryId) byCategory.set(String(row.categoryId), row);
  });

  tenantRows.forEach((row) => {
    if (row?.categoryId) byCategory.set(String(row.categoryId), row);
  });

  return Array.from(byCategory.values());
}


function toFlatStringRows(matrix) {
  if (!Array.isArray(matrix)) return [];
  return matrix
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? '').trim()));
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function inferInputKind(rule) {
  const text = String(rule || '').toLowerCase();
  if (text.includes('date in format yyyy/mm/dd')) return 'date';
  if (text.includes('select dropdown options')) return 'select';
  if (text.includes('input suggest value or customize value')) return 'suggest_or_text';
  if (text.includes('input customize value')) return 'text';
  return 'text';
}

function isCandidateValue(text) {
  if (!text) return false;

  const value = String(text || '').trim();
  if (!value) return false;
  if (value.length > 120) return false;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return true;
  if (/[A-Za-z0-9]/.test(value) === false) return false;

  const lowered = value.toLowerCase();

  if (['attribute', 'description', 'requirement', 'mandatory', 'conditional mandatory', 'rule'].includes(lowered)) return false;

  // Internal template/code values are not selectable user values.
  if (/^(ps_|et_)/i.test(value)) return false;
  if (/^ps_product_global_attribute\.\d+$/i.test(value)) return false;
  if (/^ps_tmpl_/i.test(value)) return false;

  // Common template labels are not actual option values.
  if ([
    'attribute value mapping',
    'attribute',
    'attribute name',
    'attribute id',
    'category',
    'category id',
    'input type',
    'input validation',
    'valid value',
    'suggest value',
    'input sample',
  ].includes(lowered)) return false;

  return true;
}

function extractCandidatesFromRows(rows, tokens) {
  const tokenSet = new Set((tokens || []).map(normalizeToken).filter(Boolean));
  if (!tokenSet.size) return [];

  const out = [];
  const seen = new Set();
  const tokenList = Array.from(tokenSet);

  rows.forEach((row) => {
    const normalized = row.map(normalizeToken);
    const matched = normalized.some((cell) =>
      tokenSet.has(cell) || tokenList.some((token) => token && cell.includes(token))
    );

    if (!matched) return;

    row.forEach((cellRaw, idx) => {
      const cell = String(cellRaw || '').trim();
      const norm = normalized[idx];

      if (!cell || tokenSet.has(norm)) return;
      if (tokenList.some((token) => token && norm.includes(token))) return;
      if (!isCandidateValue(cell)) return;

      const key = cell.toLowerCase();
      if (seen.has(key)) return;

      seen.add(key);
      out.push(cell);
    });
  });

  return out.slice(0, 100);
}

function extractCandidatesFromAttributeValueMapping(rows, { attributeName, code }) {
  if (!Array.isArray(rows) || !rows.length) return [];

  const normalizedName = normalizeToken(attributeName);
  const normalizedCode = normalizeToken(code);
  const matchedCols = new Set();

  const codeRow = rows[0] || [];
  const attrRow = rows[3] || [];

  codeRow.forEach((cell, idx) => {
    if (normalizedCode && normalizeToken(cell) === normalizedCode) {
      matchedCols.add(idx);
    }
  });

  attrRow.forEach((cell, idx) => {
    if (normalizedName && normalizeToken(cell) === normalizedName) {
      matchedCols.add(idx);
    }
  });

  const out = [];
  const seen = new Set();

  matchedCols.forEach((colIdx) => {
    for (let r = 6; r < rows.length; r += 1) {
      const value = String(rows[r]?.[colIdx] || '').trim();
      if (!isCandidateValue(value)) continue;

      const key = value.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      out.push(value);
    }
  });

  return out.slice(0, 100);
}



async function loadRequiredValuesForCategory({ tenantId, categoryId }) {
  const candidates = [
    path.join(REQUIRED_VALUES_ROOT, 'shared', categoryId, 'values.json'),
    path.join(REQUIRED_VALUES_ROOT, `tenant_${tenantId}`, categoryId, 'values.json'),
  ];

  const merged = new Map();
  let source = 'none';

  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      const items = normalizeRequiredValueItems(data?.items || []);

      items.forEach((item) => {
        if (!item.attributeName || !item.value) return;
        merged.set(String(item.attributeName).trim().toLowerCase(), item);
      });

      source = data?.scope || (filePath.includes('/shared/') ? 'shared' : 'tenant');
    } catch {
      // optional
    }
  }

  return {
    source,
    items: Array.from(merged.values()),
  };
}

function normalizeRequiredValueItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      attributeName: String(item?.attributeName || '').trim(),
      value: String(item?.value || '').trim(),
      columnIndex: item?.columnIndex ?? null,
      requirement: String(item?.requirement || '').trim(),
      rule: String(item?.rule || '').trim(),
      code: String(item?.code || '').trim(),
      source: String(item?.source || 'manual').trim(),
    }))
    .filter((item) => item.attributeName);
}


function normalizeCategorySearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function scoreCategoryCatalogMatch(query, category) {
  const q = normalizeCategorySearchText(query);
  if (!q) return 0;

  const categoryId = normalizeCategorySearchText(category?.categoryId);
  const categoryPath = normalizeCategorySearchText(category?.categoryPath || category?.categoryName || '');
  const haystack = `${categoryId} ${categoryPath}`.trim();

  if (!haystack) return 0;
  if (haystack === q) return 1000;
  if (categoryId === q) return 950;
  if (categoryPath.includes(q)) return 800;

  const terms = q.split(' ').filter(Boolean);
  if (!terms.length) return 0;

  let matched = 0;
  terms.forEach((term) => {
    if (haystack.includes(term)) matched += 1;
  });

  if (!matched) return 0;
  return 100 + matched * 20;
}

async function readCategoryCatalog(scope, tenantId) {
  const catalogPath = scope === 'tenant'
    ? path.join(CATEGORY_CATALOG_ROOT, `tenant_${tenantId}`, 'catalog.json')
    : path.join(CATEGORY_CATALOG_ROOT, 'shared', 'catalog.json');

  try {
    const raw = await fs.readFile(catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeCategoryCatalog(scope, tenantId, rows) {
  const dir = scope === 'tenant'
    ? path.join(CATEGORY_CATALOG_ROOT, `tenant_${tenantId}`)
    : path.join(CATEGORY_CATALOG_ROOT, 'shared');

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'catalog.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

async function upsertCategoryCatalog({ tenantId, scope, categoryId, categoryPath, templateRef }) {
  const key = String(categoryId || '').trim();
  if (!key) return;

  const now = new Date().toISOString();
  const rows = await readCategoryCatalog(scope, tenantId);
  const byId = new Map(rows.map((row) => [String(row?.categoryId || '').trim(), row]));

  const existing = byId.get(key) || null;
  const refs = Array.isArray(existing?.templateRefs) ? [...existing.templateRefs] : [];

  if (templateRef?.fileName) {
    const refKey = `${String(templateRef.categoryId || '')}|${String(templateRef.fileName || '')}|${String(templateRef.uploadedAt || '')}`;
    const exists = refs.some((ref) =>
      `${String(ref?.categoryId || '')}|${String(ref?.fileName || '')}|${String(ref?.uploadedAt || '')}` === refKey
    );
    if (!exists) refs.push(templateRef);
  }

  byId.set(key, {
    categoryId: key,
    categoryPath: String(categoryPath || '').trim() || existing?.categoryPath || key,
    source: 'template_upload',
    scope,
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now,
    templateRefs: refs.slice(-50),
  });

  await writeCategoryCatalog(scope, tenantId, Array.from(byId.values()));
}

async function searchCategoryCatalog({ tenantId, q }) {
  const query = String(q || '').trim();
  if (!query) return [];

  const seedRows = Array.isArray(KRSC_CATEGORY_CATALOG_SEED) ? KRSC_CATEGORY_CATALOG_SEED : [];
  const sharedRows = await readCategoryCatalog('shared', tenantId);
  const tenantRows = await readCategoryCatalog('tenant', tenantId);

  const combined = [];

  seedRows.forEach((row) => {
    combined.push({
      ...row,
      source: 'global_catalog_seed',
      sourcePriority: 1,
      matchedBy: 'seed',
    });
  });

  sharedRows.forEach((row) => {
    combined.push({
      ...row,
      source: 'global_catalog_shared',
      sourcePriority: 2,
      matchedBy: 'catalog',
    });
  });

  tenantRows.forEach((row) => {
    combined.push({
      ...row,
      source: 'global_catalog_tenant',
      sourcePriority: 3,
      matchedBy: 'catalog',
    });
  });

  const seen = new Set();

  return combined
    .map((row) => ({ row, score: scoreCategoryCatalogMatch(query, row) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (a.row.sourcePriority - b.row.sourcePriority) || (b.score - a.score))
    .map((entry) => entry.row)
    .filter((row) => {
      const key = String(row.categoryId || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      categoryId: String(row.categoryId || '').trim(),
      categoryPath: String(row.categoryPath || row.categoryName || row.categoryId || '').trim(),
      source: row.source,
      sourcePriority: row.sourcePriority,
      matchedBy: row.matchedBy,
    }));
}

function sendResult(res, result) {
  return res.json(sanitizeObjectForMetaResponse(result || {}));
}

router.get('/status', async (req, res) => sendResult(res, await getShopeeMetaStatus({ tenantId: getTenantId(req) })));
router.post('/category-recommend', async (req, res) => sendResult(res, await recommendCategory({ tenantId: getTenantId(req), name: req.body?.name, description: req.body?.description })));
router.get('/categories', async (req, res) => sendResult(res, await fetchCategories({ tenantId: getTenantId(req) })));
router.get('/attributes', async (req, res) => sendResult(res, await fetchAttributes({ tenantId: getTenantId(req), categoryId: String(req.query.category_id || '').trim() })));
router.get('/brands', async (req, res) => sendResult(res, await fetchBrands({ tenantId: getTenantId(req), categoryId: String(req.query.category_id || '').trim() })));


router.get('/mass-upload/templates', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED', templates: [] });

  const templates = await readTenantTemplates(tenantId);
  return sendResult(res, { ok: true, templates });
});

router.post('/mass-upload/templates', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const categoryId = sanitizeCategoryId(req.body?.categoryId);
  const categoryPath = String(req.body?.categoryPath || '').trim();
  const fileName = String(req.body?.fileName || '').trim();
  const fileBase64 = String(req.body?.fileBase64 || '').trim();
  const analysis = req.body?.analysis && typeof req.body.analysis === 'object' ? req.body.analysis : null;

  if (!categoryId) return sendResult(res, { ok: false, error: 'CATEGORY_ID_REQUIRED' });
  if (!fileName) return sendResult(res, { ok: false, error: 'FILE_NAME_REQUIRED' });
  if (!/\.xlsx$/i.test(fileName)) return sendResult(res, { ok: false, error: 'ONLY_XLSX_ALLOWED' });
  if (!fileBase64) return sendResult(res, { ok: false, error: 'FILE_BASE64_REQUIRED' });

  const normalizedBase64 = fileBase64.replace(/^data:.*;base64,/, '');
  let fileBuffer;

  try {
    fileBuffer = Buffer.from(normalizedBase64, 'base64');
  } catch {
    return sendResult(res, { ok: false, error: 'INVALID_BASE64' });
  }

  if (!fileBuffer?.length) return sendResult(res, { ok: false, error: 'EMPTY_FILE' });
  if (fileBuffer.length > MAX_TEMPLATE_SIZE_BYTES) return sendResult(res, { ok: false, error: 'FILE_TOO_LARGE' });

  const targetDir = path.join(TEMPLATE_ROOT, `tenant_${tenantId}`, categoryId);
  const targetFilePath = path.join(targetDir, 'template.xlsx');
  const metadataPath = path.join(targetDir, 'metadata.json');

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetFilePath, fileBuffer);

  const metadata = {
    tenantId: Number(tenantId) || tenantId,
    categoryId,
    categoryPath,
    fileName,
    storedFileName: 'template.xlsx',
    fileSize: fileBuffer.length,
    uploadedAt: new Date().toISOString(),
    analysis,
  };

  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const catalogWarnings = [];
  const templateRef = {
    categoryId,
    fileName,
    uploadedAt: metadata.uploadedAt,
  };

  try {
    await upsertCategoryCatalog({ tenantId, scope: 'shared', categoryId, categoryPath, templateRef });
  } catch (err) {
    catalogWarnings.push({ scope: 'shared', message: err?.message || 'catalog upsert failed' });
  }

  try {
    await upsertCategoryCatalog({ tenantId, scope: 'tenant', categoryId, categoryPath, templateRef });
  } catch (err) {
    catalogWarnings.push({ scope: 'tenant', message: err?.message || 'catalog upsert failed' });
  }

  return sendResult(res, { ok: true, template: metadata, warnings: catalogWarnings });
});

router.delete('/mass-upload/templates/:categoryId', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const categoryId = sanitizeCategoryId(req.params?.categoryId);
  if (!categoryId) return sendResult(res, { ok: false, error: 'CATEGORY_ID_REQUIRED' });

  const targetDir = path.join(TEMPLATE_ROOT, `tenant_${tenantId}`, categoryId);
  await fs.rm(targetDir, { recursive: true, force: true });

  return sendResult(res, { ok: true });
});






router.post('/mass-upload/images', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return sendResult(res, { ok: false, error: 'FILES_REQUIRED' });
  if (files.length > MAX_IMAGE_FILES) return sendResult(res, { ok: false, error: 'FILES_TOO_MANY' });

  const jobId = safeName(req.body?.jobId || makeImageJobId());
  if (!jobId) return sendResult(res, { ok: false, error: 'JOB_ID_REQUIRED' });

  const { tenantFolder } = getTenantImageDir(tenantId);
  const { jobDir: targetDir } = getTenantImageJobDir(tenantId, jobId);
  await fs.mkdir(targetDir, { recursive: true });

  const images = [];

  for (const file of files) {
    const fileName = safeName(file?.fileName || '');
    if (!safeImageExt(fileName)) continue;

    const raw = String(file?.fileBase64 || '').replace(/^data:.*;base64,/, '');
    let buffer;

    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      continue;
    }

    if (!buffer?.length || buffer.length > MAX_IMAGE_BYTES) continue;

    await fs.writeFile(path.join(targetDir, fileName), buffer);

    const stem = fileName.replace(/\.[^.]+$/, '');
    images.push({
      fileName,
      stem,
      publicUrl: `https://junandkang.com/api/shopee-meta/mass-upload/images/public/${tenantFolder}/${encodeURIComponent(jobId)}/${encodeURIComponent(fileName)}`,
      size: buffer.length,
    });
  }

  const metadata = {
    tenantId: Number(tenantId) || tenantId,
    jobId,
    uploadedAt: new Date().toISOString(),
    images,
  };

  await fs.writeFile(path.join(targetDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  return sendResult(res, { ok: true, jobId, images });
});

router.get('/mass-upload/images', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const jobs = await readImageJobsForTenant(tenantId);
  const summary = summarizeImageJobs(jobs);

  return sendResult(res, { ok: true, jobs, ...summary });
});

router.post('/mass-upload/images/cleanup', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const rawOlderThanHours = Number(req.body?.olderThanHours ?? req.query?.olderThanHours ?? 24);
  const olderThanHours = Number.isFinite(rawOlderThanHours) && rawOlderThanHours > 0 ? rawOlderThanHours : 24;
  const dryRun = req.body?.dryRun === true || req.query?.dryRun === 'true';
  const cutoffMs = Date.now() - (olderThanHours * 60 * 60 * 1000);
  const jobs = await readImageJobsForTenant(tenantId);
  const expiredJobs = jobs.filter((job) => {
    const uploadedMs = Date.parse(job?.uploadedAt || '');
    return Number.isFinite(uploadedMs) && uploadedMs < cutoffMs;
  });

  let deletedJobCount = 0;
  let deletedFileCount = 0;
  let deletedBytes = 0;

  for (const job of expiredJobs) {
    const rawJobId = String(job?.jobId || '');
    const jobId = safeName(rawJobId);
    if (!jobId || jobId !== rawJobId) continue;

    const { jobDir } = getTenantImageJobDir(tenantId, jobId);
    deletedJobCount += 1;
    deletedFileCount += Number(job?.fileCount) || 0;
    deletedBytes += Number(job?.totalBytes) || 0;

    if (!dryRun) {
      await fs.rm(jobDir, { recursive: true, force: true });
    }
  }

  return sendResult(res, {
    ok: true,
    dryRun,
    olderThanHours,
    deletedJobCount,
    deletedFileCount,
    deletedBytes,
    jobs: expiredJobs.map((job) => ({
      jobId: job.jobId,
      uploadedAt: job.uploadedAt,
      fileCount: job.fileCount,
      totalBytes: job.totalBytes,
    })),
  });
});

router.delete('/mass-upload/images/:jobId', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const rawJobId = String(req.params?.jobId || '');
  const jobId = safeName(rawJobId);
  if (!jobId || jobId !== rawJobId) return sendResult(res, { ok: false, error: 'JOB_ID_REQUIRED' });

  const { jobDir } = getTenantImageJobDir(tenantId, jobId);
  const summary = await summarizeDirectory(jobDir);
  await fs.rm(jobDir, { recursive: true, force: true });

  return sendResult(res, {
    ok: true,
    jobId,
    deletedJobCount: 1,
    deletedFileCount: summary.fileCount,
    deletedBytes: summary.totalBytes,
  });
});





router.get('/mass-upload/category-search', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED', categories: [] });

  const q = String(req.query?.q || '').trim();
  if (!q) return sendResult(res, { ok: true, categories: [] });

  const catalogMatches = await searchCategoryCatalog({ tenantId, q });
  const seen = new Set(catalogMatches.map((row) => String(row.categoryId || '').trim()));

  const templates = await readTenantTemplates(tenantId);
  const fallback = templates
    .map((template) => ({
      categoryId: String(template?.categoryId || '').trim(),
      categoryPath: String(template?.categoryPath || template?.categoryName || template?.categoryId || '').trim(),
      source: 'template_registry_fallback',
      sourcePriority: 4,
      matchedBy: 'template_registry',
    }))
    .filter((row) => row.categoryId && !seen.has(row.categoryId))
    .map((row) => ({ row, score: scoreCategoryCatalogMatch(q, row) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.row);

  const categories = [...catalogMatches, ...fallback].slice(0, 50);

  return sendResult(res, { ok: true, categories });
});


router.get('/mass-upload/required-value-options', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED', options: [] });

  const categoryId = sanitizeCategoryId(req.query?.category_id);
  if (!categoryId) return sendResult(res, { ok: false, error: 'CATEGORY_ID_REQUIRED', options: [] });

  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    return sendResult(res, { ok: false, error: 'XLSX_BACKEND_UNAVAILABLE', options: [] });
  }

  const loadedTemplate = await loadTemplateForCategory({ tenantId, categoryId });
  if (!loadedTemplate) {
    return sendResult(res, { ok: false, error: 'TEMPLATE_NOT_FOUND', categoryId, options: [] });
  }

  const workbook = XLSX.read(await fs.readFile(loadedTemplate.templatePath), { type: 'buffer' });
  const templateSheet = workbook.Sheets.Template;

  if (!templateSheet) {
    return sendResult(res, { ok: false, error: 'TEMPLATE_SHEET_NOT_FOUND', categoryId, options: [] });
  }

  const templateRows = XLSX.utils.sheet_to_json(templateSheet, { header: 1, defval: '' });
  const pick = (r, c) => String(templateRows?.[r]?.[c] || '').trim();

  const colCount = Math.max(
    (templateRows?.[0] || []).length,
    (templateRows?.[2] || []).length,
    (templateRows?.[3] || []).length,
    (templateRows?.[4] || []).length,
    (templateRows?.[5] || []).length
  );

  const mappingRows = toFlatStringRows(
    XLSX.utils.sheet_to_json(workbook.Sheets['Attribute value mapping'] || {}, { header: 1, defval: '' })
  );
  const hiddenAttrRows = toFlatStringRows(
    XLSX.utils.sheet_to_json(workbook.Sheets.HiddenAttr || {}, { header: 1, defval: '' })
  );
  const hiddenCatPropsRows = toFlatStringRows(
    XLSX.utils.sheet_to_json(workbook.Sheets.HiddenCatProps || {}, { header: 1, defval: '' })
  );

  const options = [];

  for (let idx = 0; idx < colCount; idx += 1) {
    const code = pick(0, idx);
    const attributeName = pick(2, idx);
    const requirement = pick(3, idx);
    const rule = pick(5, idx);

    if (!attributeName) continue;

    const tokens = [attributeName, code].filter(Boolean);
    const mappingValues = extractCandidatesFromAttributeValueMapping(mappingRows, { attributeName, code });
    const hiddenAttrValues = extractCandidatesFromRows(hiddenAttrRows, tokens);
    const hiddenCatValues = extractCandidatesFromRows(hiddenCatPropsRows, tokens);

    const merged = [];
    const seen = new Set();

    [mappingValues, hiddenAttrValues, hiddenCatValues].forEach((list) => {
      list.forEach((value) => {
        const key = String(value || '').trim().toLowerCase();
        if (!key || seen.has(key)) return;

        seen.add(key);
        merged.push(String(value).trim());
      });
    });

    const source = mappingValues.length > 0
      ? 'attribute_value_mapping'
      : hiddenAttrValues.length > 0
        ? 'hidden_attr'
        : hiddenCatValues.length > 0
          ? 'hidden_cat_props'
          : 'none';

    options.push({
      attributeName,
      normalizedName: normalizeToken(attributeName),
      inputKind: inferInputKind(rule),
      columnIndex: idx + 1,
      code,
      requirement,
      rule,
      values: merged.slice(0, 100),
      source,
    });
  }

  return sendResult(res, {
    ok: true,
    categoryId,
    options,
    scope: loadedTemplate.scope,
  });
});


router.get('/mass-upload/required-values', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED', values: [] });

  const values = await readRequiredValuesForTenant(tenantId);
  return sendResult(res, { ok: true, values });
});

router.post('/mass-upload/required-values', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const categoryId = sanitizeCategoryId(req.body?.categoryId);
  const categoryPath = String(req.body?.categoryPath || '').trim();
  const scopeInput = String(req.body?.scope || 'shared').trim().toLowerCase();
  const scope = scopeInput === 'tenant' ? 'tenant' : 'shared';
  const items = normalizeRequiredValueItems(req.body?.items);

  if (!categoryId) return sendResult(res, { ok: false, error: 'CATEGORY_ID_REQUIRED' });
  if (!items.length) return sendResult(res, { ok: false, error: 'REQUIRED_VALUE_ITEMS_REQUIRED' });

  const baseDir = scope === 'tenant'
    ? path.join(REQUIRED_VALUES_ROOT, `tenant_${tenantId}`, categoryId)
    : path.join(REQUIRED_VALUES_ROOT, 'shared', categoryId);

  await fs.mkdir(baseDir, { recursive: true });

  const payload = {
    categoryId,
    categoryPath,
    scope,
    isShared: scope === 'shared',
    tenantId: Number(tenantId) || tenantId,
    items,
    updatedAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(baseDir, 'values.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  return sendResult(res, { ok: true, values: payload });
});

router.delete('/mass-upload/required-values/:categoryId', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const categoryId = sanitizeCategoryId(req.params?.categoryId);
  const scopeInput = String(req.query?.scope || 'shared').trim().toLowerCase();
  const scope = scopeInput === 'tenant' ? 'tenant' : 'shared';

  if (!categoryId) return sendResult(res, { ok: false, error: 'CATEGORY_ID_REQUIRED' });

  const targetDir = scope === 'tenant'
    ? path.join(REQUIRED_VALUES_ROOT, `tenant_${tenantId}`, categoryId)
    : path.join(REQUIRED_VALUES_ROOT, 'shared', categoryId);

  await fs.rm(targetDir, { recursive: true, force: true });

  return sendResult(res, { ok: true });
});


router.post('/mass-upload/generate-template-files', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    return sendResult(res, {
      ok: false,
      error: 'XLSX_BACKEND_UNAVAILABLE',
      message: 'Backend xlsx dependency is not available.',
    });
  }

  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  const metaResults = Array.isArray(req.body?.metaResults) ? req.body.metaResults : [];
  const imageJobId = safeName(req.body?.imageJobId || '');
  const byKey = new Map(metaResults.map((m) => [String(m.productKey || ''), m]));
  const groups = new Map();
  let seq = 1;

  products.forEach((product) => {
    const meta = byKey.get(String(product.id || ''));
    const categoryId = sanitizeCategoryId(meta?.category?.categoryId);
    if (!categoryId) return;

    if (!groups.has(categoryId)) {
      groups.set(categoryId, {
        categoryPath: meta?.category?.categoryPath || meta?.category?.categoryName || categoryId,
        rows: [],
      });
    }

    const integrationNo = padNo(seq++);
    const rep = Array.isArray(product.representativeImages) ? product.representativeImages : [];
    const brand = meta?.brand?.brandId === null || meta?.brand?.brandId === undefined
      ? ''
      : String(meta.brand.brandId).trim();

    (product.options || []).forEach((option, optionIndex) => {
      const first = optionIndex === 0;

      groups.get(categoryId).rows.push({
        first,
        categoryId,
        productName: first ? String(product.productName || '').trim() : '',
        productDescription: first ? String(product.description || '').trim() : '',
        coverImage: first ? String(rep[0] || '').trim() : '',
        itemImages: first ? rep.slice(0, 8).map((x) => String(x || '').trim()) : [],
        variationIntegrationNo: integrationNo,
        variationName1: 'Option',
        optionName: String(option.optionName || '').trim() || 'Default',
        optionImage: String(option.optionImage || '').trim(),
        price: String(option.price || '').trim(),
        stock: String(option.stock || '').trim(),
        sku: String(option.sku || '').trim(),
        weight: gramsToKgForShopee(option.weight),
        length: String(option.length || '').trim(),
        width: String(option.width || '').trim(),
        height: String(option.height || '').trim(),
        daysToShip: '1',
        brand,
      });
    });
  });


  const imageMap = new Map();

  if (imageJobId) {
    try {
      const imageMetaPath = path.join(IMAGE_ROOT, `tenant_${tenantId}`, imageJobId, 'metadata.json');
      const imageMeta = JSON.parse(await fs.readFile(imageMetaPath, 'utf8'));

      (Array.isArray(imageMeta?.images) ? imageMeta.images : []).forEach((image) => {
        const stem = String(image?.stem || '').trim();
        const publicUrl = String(image?.publicUrl || '').trim();
        if (stem && publicUrl) imageMap.set(stem, publicUrl);
      });
    } catch {
      // image job is optional
    }
  }

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const outputDir = path.join(GENERATED_ROOT, `tenant_${tenantId}`, timestamp);
  await fs.mkdir(outputDir, { recursive: true });

  const files = [];
  const warnings = [];

  for (const [categoryId, group] of groups.entries()) {
    const loadedTemplate = await loadTemplateForCategory({ tenantId, categoryId });

    if (!loadedTemplate) {
      warnings.push({ categoryId, rowIndex: null, missing: ['template.xlsx'] });
      continue;
    }

    const { metadata, templatePath } = loadedTemplate;
    const workbook = XLSX.read(await fs.readFile(templatePath), { type: 'buffer' });
    const sheet = workbook.Sheets.Template;
    if (!sheet) {
      warnings.push({ categoryId, rowIndex: null, missing: ['Template sheet'] });
      continue;
    }

    const mappingCandidates = Array.isArray(metadata?.analysis?.mappingCandidates)
      ? metadata.analysis.mappingCandidates
      : [];

    const requiredValues = await loadRequiredValuesForCategory({ tenantId, categoryId });
    const requiredValueByHeader = new Map(
      (requiredValues.items || []).map((item) => [
        String(item.attributeName || '').trim().toLowerCase(),
        item,
      ])
    );

    const colByHeader = new Map();
    mappingCandidates.forEach((m) => {
      const key = String(m.templateHeader || '').trim().toLowerCase();
      const value = Number(m.templateColumn || 0);
      if (key && value && !colByHeader.has(key)) {
        colByHeader.set(key, value);
      }
    });
    const col = (header) => colByHeader.get(String(header).toLowerCase()) || 0;
    const put = (row, colIdx, value) => {
      if (!colIdx) return;
      XLSX.utils.sheet_add_aoa(sheet, [[value]], { origin: { r: row - 1, c: colIdx - 1 } });
    };

    let rowNo = 7;
    group.rows.forEach((row) => {
      put(rowNo, col('Category'), row.categoryId);
      put(rowNo, col('Product Name'), row.productName);
      put(rowNo, col('Product Description'), row.productDescription);
      put(rowNo, col('Variation Integration No.'), row.variationIntegrationNo);
      put(rowNo, col('Variation Name1'), row.variationName1);
      put(rowNo, col('Option for Variation 1'), row.optionName);
      const firstSku = row.first ? String(row.sku || '').trim() : '';
      const optionImage = imageMap.get(String(row.sku || '').trim()) || row.optionImage;
      const coverImage = row.first && firstSku
        ? (
          imageMap.get(`${firstSku}-m1`)
          || imageMap.get(`${firstSku}-m`)
          || imageMap.get(firstSku)
          || row.coverImage
        )
        : row.coverImage;
      const itemImages = row.first
        ? Array.from({ length: 8 }).map((_, index) => {
          const mainImage = firstSku ? imageMap.get(`${firstSku}-m${index + 1}`) : '';
          if (mainImage) return mainImage;
          if (index === 0 && firstSku) {
            return imageMap.get(`${firstSku}-m`) || imageMap.get(firstSku) || row.itemImages[index] || '';
          }
          return row.itemImages[index] || '';
        })
        : [];

      put(rowNo, col('Image per Variation'), optionImage);
      put(rowNo, col('Global SKU Price'), row.price);
      put(rowNo, col('Stock'), row.stock);
      put(rowNo, col('SKU'), row.sku);
      put(rowNo, col('Cover image'), coverImage);
      for (let i = 1; i <= 8; i += 1) {
        put(rowNo, col(`Item Image ${i}`), row.first ? (itemImages[i - 1] || '') : '');
      }
      put(rowNo, col('Weight'), row.weight);
      put(rowNo, col('Length'), row.length);
      put(rowNo, col('Width'), row.width);
      put(rowNo, col('Height'), row.height);
      put(rowNo, col('Days to ship'), row.daysToShip);
      put(rowNo, col('Brand'), row.brand);

      if (requiredValueByHeader.size > 0) {
        requiredValueByHeader.forEach((requiredValue, normalizedHeader) => {
          const explicitColumn = Number(requiredValue?.columnIndex || 0);
          const targetColumn = explicitColumn > 0 ? explicitColumn : col(normalizedHeader);
          if (!targetColumn) return;
          put(rowNo, targetColumn, requiredValue.value);
        });
      }

      const missing = [];
      if (!row.categoryId) missing.push('category_id');
      if (row.first && !row.productName) missing.push('Product Name');
      if (row.first && !row.productDescription) missing.push('Product Description');
      if (row.first && !coverImage) missing.push('Cover image');
      if (!row.price) missing.push('Global SKU Price');
      if (!row.stock) missing.push('Stock');
      if (!row.sku) missing.push('SKU');
      if (!row.weight) missing.push('Weight');
      if (!row.daysToShip) missing.push('Days to ship');
      if (!row.brand) missing.push('Brand');

      if (missing.length) warnings.push({ categoryId, rowIndex: rowNo, missing });
      rowNo += 1;
    });

    const outputName = safeName(`KRSC_upload_${categoryId}_${timestamp}.xlsx`);
    const outputPath = path.join(outputDir, outputName);
    XLSX.writeFile(workbook, outputPath);

    files.push({
      categoryId,
      categoryPath: group.categoryPath,
      fileName: outputName,
      downloadUrl: `/api/shopee-meta/mass-upload/generated-files/${encodeURIComponent(timestamp)}__${encodeURIComponent(outputName)}`,
    });
  }

  return sendResult(res, { ok: true, files, warnings });
});

router.get('/mass-upload/generated-files/:fileName', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const raw = String(req.params?.fileName || '');
  const [timestamp, fileName] = raw.split('__');
  if (!timestamp || !fileName) return sendResult(res, { ok: false, error: 'INVALID_FILE_NAME' });

  const filePath = path.join(GENERATED_ROOT, `tenant_${tenantId}`, safeName(timestamp), safeName(fileName));
  return res.download(filePath);
});


router.post('/mass-upload/auto-metadata', async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  return sendResult(res, await autoMetadataBatchDisabled({ products }));
});

router.post('/mass-upload/krsc-prepare', async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  return sendResult(res, await krscPrepare({ tenantId: getTenantId(req), products }));
});

module.exports = router;
