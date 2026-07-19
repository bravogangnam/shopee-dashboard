const express = require('express');
const router = express.Router();
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const {
  getLowStockProducts,
  getInventoryProducts,
  getInventorySummary,
  getTodayOrderInventory,
  updateProductStockSettings,
  manuallyAdjustStock,
  adjustStartBalanceStock,
  getInventoryMovements,
  restorePendingCancellation,
} = require('../services/inventoryService');
const { getCancellationReviews } = require('../services/inventoryCancellationReviewService');
const { getCurrentTenantId } = require('../config/tenant');
const { syncPendingInventoryReceipts } = require('../services/inventoryReceiptSync');
const { refreshSkuCompositionsFromSheet } = require('../services/skuCompositionService');

router.use(requireAuth);
router.use(requireApprovedTenant);

function decodeSkuParam(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

router.get('/low-stock', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const scope = req.query.scope === 'all' ? 'all' : 'low-stock';
  const products = scope === 'all'
    ? await getInventoryProducts({ scope, tenantId })
    : await getLowStockProducts({ tenantId });
  const summary = await getInventorySummary({ tenantId });
  return res.json({ success: true, data: products, summary });
});

router.get('/inventory/today-orders', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const result = await getTodayOrderInventory({ tenantId });
  return res.json({ success: true, ...result });
});

router.get('/inventory/cancellation-reviews', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const data = await getCancellationReviews({
    tenantId,
    decision: req.query.decision,
    limit: req.query.limit,
  });
  return res.json({ success: true, data });
});

router.post('/inventory/cancellation-reviews/:shopId/:orderSn/restore', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const result = await restorePendingCancellation({
    tenantId,
    shopId: req.params.shopId,
    orderSn: req.params.orderSn,
  });
  return res.json({ success: true, result });
});

router.post('/inventory-receipts/sync', async (req, res) => {
  return res.status(410).json({
    success: false,
    error: '입고관리 시트 동기화는 중단되었습니다. 앞으로 입고 관리는 대시보드 입고 관리 메뉴에서 처리하세요.',
  });
});

router.post('/sku-compositions/refresh', async (req, res) => {
  return res.status(410).json({
    success: false,
    error: '상품구성표 시트 동기화는 중단되었습니다. 앞으로 상품구성표는 대시보드 입고 관리 > 상품구성표에서 관리하세요.',
  });
});

router.patch('/:sku/stock', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const sku = decodeSkuParam(req.params.sku);
  const allowed = ['stock_quantity', 'low_stock_threshold', 'stock_tracking_started_at'];
  const data = {};

  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      data[field] = req.body[field];
    }
  }

  await updateProductStockSettings(sku, data, { tenantId });
  return res.json({ success: true, message: 'Stock settings updated' });
});

router.post('/:sku/stock/adjust', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const sku = decodeSkuParam(req.params.sku);
  const { qty_delta, note } = req.body;

  await manuallyAdjustStock({ sku, qty_delta, note }, { tenantId });
  return res.json({ success: true, message: 'Stock adjusted' });
});

router.post('/:sku/stock/start-balance-adjust', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const sku = decodeSkuParam(req.params.sku);
  const { target_stock_quantity, note } = req.body;

  const result = await adjustStartBalanceStock({ sku, target_stock_quantity, note }, { tenantId });
  return res.json({
    success: true,
    message: 'Start balance adjusted',
    result,
  });
});

router.get('/:sku/inventory-movements', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const sku = decodeSkuParam(req.params.sku);
  const movements = await getInventoryMovements(sku, req.query.limit, { tenantId });
  return res.json({ success: true, data: movements });
});

module.exports = router;
