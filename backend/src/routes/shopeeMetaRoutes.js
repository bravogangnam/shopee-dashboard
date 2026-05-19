const express = require('express');
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

function sendResult(res, result) {
  return res.json(sanitizeObjectForMetaResponse(result || {}));
}

router.get('/status', async (req, res) => sendResult(res, await getShopeeMetaStatus({ tenantId: getTenantId(req) })));
router.post('/category-recommend', async (req, res) => sendResult(res, await recommendCategory({ tenantId: getTenantId(req), name: req.body?.name, description: req.body?.description })));
router.get('/categories', async (req, res) => sendResult(res, await fetchCategories({ tenantId: getTenantId(req) })));
router.get('/attributes', async (req, res) => sendResult(res, await fetchAttributes({ tenantId: getTenantId(req), categoryId: String(req.query.category_id || '').trim() })));
router.get('/brands', async (req, res) => sendResult(res, await fetchBrands({ tenantId: getTenantId(req), categoryId: String(req.query.category_id || '').trim() })));



router.post('/mass-upload/auto-metadata', async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  return sendResult(res, await autoMetadataBatchDisabled({ products }));
});

router.post('/mass-upload/krsc-prepare', async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  return sendResult(res, await krscPrepare({ tenantId: getTenantId(req), products }));
});

module.exports = router;
