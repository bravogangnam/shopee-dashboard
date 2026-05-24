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






router.post('/mass-upload/images', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return sendResult(res, { ok: false, error: 'FILES_REQUIRED' });
  if (files.length > MAX_IMAGE_FILES) return sendResult(res, { ok: false, error: 'FILES_TOO_MANY' });

  const jobId = safeName(req.body?.jobId || makeImageJobId());
  if (!jobId) return sendResult(res, { ok: false, error: 'JOB_ID_REQUIRED' });

  const tenantFolder = `tenant_${tenantId}`;
  const targetDir = path.join(IMAGE_ROOT, tenantFolder, jobId);
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

  const tenantDir = path.join(IMAGE_ROOT, `tenant_${tenantId}`);
  let entries = [];

  try {
    entries = await fs.readdir(tenantDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return sendResult(res, { ok: true, jobs: [] });
    throw err;
  }

  const jobs = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const raw = await fs.readFile(path.join(tenantDir, entry.name, 'metadata.json'), 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
  );

  return sendResult(res, { ok: true, jobs: jobs.filter(Boolean) });
});

router.delete('/mass-upload/images/:jobId', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return sendResult(res, { ok: false, error: 'TENANT_CONTEXT_REQUIRED' });

  const jobId = safeName(req.params?.jobId || '');
  if (!jobId) return sendResult(res, { ok: false, error: 'JOB_ID_REQUIRED' });

  await fs.rm(path.join(IMAGE_ROOT, `tenant_${tenantId}`, jobId), { recursive: true, force: true });

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
