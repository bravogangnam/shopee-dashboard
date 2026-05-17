const express = require('express');
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const {
  sanitizeObjectForMetaResponse,
  getShopeeMetaStatus,
  recommendCategory,
  fetchCategories,
  fetchAttributes,
  fetchBrands,
  fetchDtsLimit,
} = require('../services/shopeeMetaService');

const router = express.Router();

router.use(requireAuth);
router.use(requireApprovedTenant);

function getTenantIdFromRequest(req) {
  return req?.tenantId ?? req?.user?.tenant_id ?? req?.user?.tenantId ?? null;
}

function normalizeMarket(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function sendResult(res, result) {
  const safe = sanitizeObjectForMetaResponse(result || {});
  if (safe.ok === false && safe.error === 'TENANT_CONTEXT_REQUIRED') return res.status(401).json(safe);
  if (safe.ok === false && safe.error === 'NO_ACTIVE_SHOP_TOKEN') return res.status(404).json(safe);
  if (safe.ok === false && (safe.error === 'SHOPEE_META_LIVE_CALL_DISABLED' || safe.error === 'SHOPEE_META_NOT_IMPLEMENTED')) return res.status(501).json(safe);
  if (safe.ok === false && safe.error === 'INVALID_REQUEST') return res.status(400).json(safe);
  return res.json(safe);
}

router.get('/status', async (req, res) => {
  const tenantId = getTenantIdFromRequest(req);
  if (!tenantId) return res.status(401).json({ ok: false, error: 'TENANT_CONTEXT_REQUIRED', message: 'tenant_id context is required.' });
  return sendResult(res, await getShopeeMetaStatus({ tenantId }));
});

router.post('/category-recommend', async (req, res) => {
  const tenantId = getTenantIdFromRequest(req);
  if (!tenantId) return res.status(401).json({ ok: false, error: 'TENANT_CONTEXT_REQUIRED', message: 'tenant_id context is required.' });

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const market = normalizeMarket(req.body?.market);

  return sendResult(res, await recommendCategory({ tenantId, market, name, description }));
});

router.get('/categories', async (req, res) => {
  const tenantId = getTenantIdFromRequest(req);
  if (!tenantId) return res.status(401).json({ ok: false, error: 'TENANT_CONTEXT_REQUIRED', message: 'tenant_id context is required.' });
  return sendResult(res, await fetchCategories({ tenantId, market: normalizeMarket(req.query.market) }));
});

router.get('/attributes', async (req, res) => {
  const tenantId = getTenantIdFromRequest(req);
  if (!tenantId) return res.status(401).json({ ok: false, error: 'TENANT_CONTEXT_REQUIRED', message: 'tenant_id context is required.' });
  const categoryId = typeof req.query.category_id === 'string' ? req.query.category_id.trim() : '';
  return sendResult(res, await fetchAttributes({ tenantId, market: normalizeMarket(req.query.market), categoryId }));
});

router.get('/brands', async (req, res) => {
  const tenantId = getTenantIdFromRequest(req);
  if (!tenantId) return res.status(401).json({ ok: false, error: 'TENANT_CONTEXT_REQUIRED', message: 'tenant_id context is required.' });
  const categoryId = typeof req.query.category_id === 'string' ? req.query.category_id.trim() : '';
  return sendResult(res, await fetchBrands({ tenantId, market: normalizeMarket(req.query.market), categoryId }));
});

router.get('/dts-limit', async (req, res) => {
  const tenantId = getTenantIdFromRequest(req);
  if (!tenantId) return res.status(401).json({ ok: false, error: 'TENANT_CONTEXT_REQUIRED', message: 'tenant_id context is required.' });
  const categoryId = typeof req.query.category_id === 'string' ? req.query.category_id.trim() : '';
  return sendResult(res, await fetchDtsLimit({ tenantId, market: normalizeMarket(req.query.market), categoryId }));
});

router.use((err, req, res, next) => {
  console.error('[ShopeeMetaRoute] error:', err.message);
  return res.status(500).json(sanitizeObjectForMetaResponse({ ok: false, error: 'SHOPEE_META_NOT_IMPLEMENTED', message: 'Shopee metadata bridge internal error.' }));
});

module.exports = router;
