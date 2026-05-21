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
router.use(requireAuth);
router.use(requireApprovedTenant);

const getTenantId = (req) => req?.tenantId ?? req?.user?.tenant_id ?? req?.user?.tenantId ?? null;

const TEMPLATE_ROOT = path.join(process.cwd(), 'storage', 'krsc-templates');
const MAX_TEMPLATE_SIZE_BYTES = 15 * 1024 * 1024;

function sanitizeCategoryId(input) {
  return String(input || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
}

async function readTenantTemplates(tenantId) {
  const tenantDir = path.join(TEMPLATE_ROOT, `tenant_${tenantId}`);
  let entries = [];

  try {
    entries = await fs.readdir(tenantDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const templates = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const metadataPath = path.join(tenantDir, entry.name, 'metadata.json');
      try {
        const raw = await fs.readFile(metadataPath, 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
  );

  return templates.filter(Boolean);
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

  return sendResult(res, { ok: true, template: metadata });
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




router.post('/mass-upload/auto-metadata', async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  return sendResult(res, await autoMetadataBatchDisabled({ products }));
});

router.post('/mass-upload/krsc-prepare', async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  return sendResult(res, await krscPrepare({ tenantId: getTenantId(req), products }));
});

module.exports = router;
