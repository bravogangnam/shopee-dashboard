const express = require('express');
const router = express.Router();
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const { getCurrentTenantId } = require('../config/tenant');
const {
  getPaymentBalanceSnapshot,
  refreshPaymentBalances,
} = require('../services/paymentBalanceService');
const { getSettlementForecast } = require('../services/settlementForecastService');

router.use(requireAuth);
router.use(requireApprovedTenant);

router.get('/', async (req, res, next) => {
  try {
    const data = await getPaymentBalanceSnapshot(getCurrentTenantId(req));
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.get('/settlement-forecast', async (req, res, next) => {
  try {
    const data = await getSettlementForecast(getCurrentTenantId(req));
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const tenantId = getCurrentTenantId(req);
    const results = await refreshPaymentBalances(tenantId);
    const data = await getPaymentBalanceSnapshot(tenantId);
    return res.json({
      success: true,
      data,
      refresh: {
        total: results.length,
        succeeded: results.filter((result) => result.success).length,
        failed: results.filter((result) => !result.success).length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
