const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  getLowStockProducts,
  updateProductStockSettings,
  manuallyAdjustStock,
  getInventoryMovements,
} = require('../services/inventoryService');

router.use(requireAuth);

function decodeSkuParam(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

router.get('/low-stock', async (req, res) => {
  const products = await getLowStockProducts();
  return res.json({ success: true, data: products });
});

router.patch('/:sku/stock', async (req, res) => {
  const sku = decodeSkuParam(req.params.sku);
  const allowed = ['stock_quantity', 'low_stock_threshold', 'stock_tracking_started_at'];
  const data = {};

  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      data[field] = req.body[field];
    }
  }

  await updateProductStockSettings(sku, data);
  return res.json({ success: true, message: 'Stock settings updated' });
});

router.post('/:sku/stock/adjust', async (req, res) => {
  const sku = decodeSkuParam(req.params.sku);
  const { qty_delta, note } = req.body;

  await manuallyAdjustStock({ sku, qty_delta, note });
  return res.json({ success: true, message: 'Stock adjusted' });
});

router.get('/:sku/inventory-movements', async (req, res) => {
  const sku = decodeSkuParam(req.params.sku);
  const movements = await getInventoryMovements(sku, req.query.limit);
  return res.json({ success: true, data: movements });
});

module.exports = router;
