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
const GENERATED_ROOT = path.join(process.cwd(), 'storage', 'krsc-generated');

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

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const outputDir = path.join(GENERATED_ROOT, `tenant_${tenantId}`, timestamp);
  await fs.mkdir(outputDir, { recursive: true });

  const files = [];
  const warnings = [];

  for (const [categoryId, group] of groups.entries()) {
    const templateDir = path.join(TEMPLATE_ROOT, `tenant_${tenantId}`, categoryId);
    const templatePath = path.join(templateDir, 'template.xlsx');
    const metadataPath = path.join(templateDir, 'metadata.json');

    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      await fs.access(templatePath);
    } catch {
      warnings.push({ categoryId, rowIndex: null, missing: ['template.xlsx'] });
      continue;
    }

    const workbook = XLSX.read(await fs.readFile(templatePath), { type: 'buffer' });
    const sheet = workbook.Sheets.Template;
    if (!sheet) {
      warnings.push({ categoryId, rowIndex: null, missing: ['Template sheet'] });
      continue;
    }

    const mappingCandidates = Array.isArray(metadata?.analysis?.mappingCandidates)
      ? metadata.analysis.mappingCandidates
      : [];
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
      put(rowNo, col('Image per Variation'), row.optionImage);
      put(rowNo, col('Global SKU Price'), row.price);
      put(rowNo, col('Stock'), row.stock);
      put(rowNo, col('SKU'), row.sku);
      put(rowNo, col('Cover image'), row.coverImage);
      for (let i = 1; i <= 8; i += 1) {
        put(rowNo, col(`Item Image ${i}`), row.first ? (row.itemImages[i - 1] || '') : '');
      }
      put(rowNo, col('Weight'), row.weight);
      put(rowNo, col('Length'), row.length);
      put(rowNo, col('Width'), row.width);
      put(rowNo, col('Height'), row.height);
      put(rowNo, col('Days to ship'), row.daysToShip);
      put(rowNo, col('Brand'), row.brand);

      const missing = [];
      if (!row.categoryId) missing.push('category_id');
      if (row.first && !row.productName) missing.push('Product Name');
      if (row.first && !row.productDescription) missing.push('Product Description');
      if (row.first && !row.coverImage) missing.push('Cover image');
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
