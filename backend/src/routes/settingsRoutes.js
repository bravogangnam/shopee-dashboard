/**
 * 설정 관련 라우트
 * GET  /api/settings/account        - main_account 정보 조회
 * PUT  /api/settings/account        - partner_id/key 업데이트
 * GET  /api/settings/shops          - 전체 샵 목록
 * PUT  /api/settings/shops/:shopId  - 샵 alias/region/is_active 업데이트
 * GET  /api/settings/rates          - 환율 목록
 * PUT  /api/settings/rates          - 환율 저장
 * POST /api/settings/rates          - 환율 추가
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireApprovedTenant, loadTenantAccessContext } = require('../middleware/auth');
const db = require('../config/database');
const { testMarginChartSheet, syncMarginChartSheet } = require('../services/tenantMarginChartSync');
const { syncAllShopProfiles } = require('../services/shopeeShopProfileService');
const { cleanupShippingLabelFiles, getRetentionDays } = require('../services/shippingLabelCleanupService');
const { getCurrentTenantId } = require('../config/tenant');
require('dotenv').config();

// 모든 설정 라우트에 인증 적용
router.use(requireAuth);
router.use(requireApprovedTenant);

function normalizeOptionalValue(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

async function isPlatformAdminRequest(req) {
  const { isPlatformAdmin } = await loadTenantAccessContext(req);
  return Number(isPlatformAdmin || 0) === 1;
}

async function getTenantRequestedMainAccountId(tenantId) {
  const [rows] = await db.query(
    'SELECT requested_main_account_id FROM tenants WHERE id = ? LIMIT 1',
    [tenantId]
  );

  const value = rows[0]?.requested_main_account_id;
  return value === undefined || value === null ? '' : String(value);
}

function buildDefaultAccountForRole(isPlatformAdmin, requestedMainAccountId = '') {
  if (isPlatformAdmin) {
    return {
      id: null,
      partner_id: process.env.SHOPEE_PARTNER_ID || '',
      partner_key: process.env.SHOPEE_PARTNER_KEY || '',
      main_account_id: process.env.SHOPEE_MAIN_ACCOUNT_ID || '',
      merchant_id: process.env.SHOPEE_MERCHANT_ID || '',
      token_status: 'none',
      token_expires_at: null,
      refresh_expires_at: null,
      updated_at: null,
    };
  }

  return {
    id: null,
    partner_id: '',
    partner_key: '',
    main_account_id: '',
    merchant_id: '',
    token_status: 'none',
    token_expires_at: null,
    refresh_expires_at: null,
    updated_at: null,
  };
}

function sanitizeAccountForRole(account, isPlatformAdmin, requestedMainAccountId = '') {
  if (isPlatformAdmin) {
    return account;
  }

  return {
    ...account,
    partner_id: '',
    partner_key: '',
    main_account_id: account?.main_account_id ? String(account.main_account_id) : '',
    merchant_id: account?.merchant_id ? String(account.merchant_id) : '',
  };
}


// ─── 계정 정보 조회 ──────────────────────────────────────────────
router.get('/account', async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.user?.tenantId;
    const isPlatformAdmin = await isPlatformAdminRequest(req);
    const requestedMainAccountId = await getTenantRequestedMainAccountId(tenantId);

    const [rows] = await db.query(
      'SELECT id, partner_id, partner_key, main_account_id, merchant_id, token_status, token_expires_at, refresh_expires_at, updated_at FROM main_account WHERE tenant_id = ? LIMIT 1',
      [tenantId]
    );

    const account = rows[0] || buildDefaultAccountForRole(isPlatformAdmin, requestedMainAccountId);

    return res.json({
      success: true,
      account: sanitizeAccountForRole(account, isPlatformAdmin, requestedMainAccountId),
    });
  } catch (err) {
    console.error('[Settings] account load failed:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to load account settings' });
  }
});

router.put('/account', async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.user?.tenantId;
    const isPlatformAdmin = await isPlatformAdminRequest(req);
    const {
      partner_id,
      partner_key,
      main_account_id,
      merchant_id,
    } = req.body || {};

    let partnerId = normalizeOptionalValue(partner_id);
    let partnerKey = normalizeOptionalValue(partner_key);
    let mainAccountId = normalizeOptionalValue(main_account_id);
    let merchantId = normalizeOptionalValue(merchant_id);

    const [existing] = await db.query(
      'SELECT id, partner_id, partner_key, main_account_id, merchant_id FROM main_account WHERE tenant_id = ? LIMIT 1',
      [tenantId]
    );

    if (isPlatformAdmin) {
      if (!partnerId || !partnerKey) {
        return res.status(400).json({ success: false, error: 'partner_id and partner_key are required' });
      }
    } else {
      partnerId = existing[0]?.partner_id || process.env.SHOPEE_PARTNER_ID || null;
      partnerKey = existing[0]?.partner_key || process.env.SHOPEE_PARTNER_KEY || null;

      if (!partnerId || !partnerKey) {
        return res.status(500).json({
          success: false,
          error: 'Platform Shopee partner configuration is missing',
        });
      }

      mainAccountId = existing[0]?.main_account_id || null;
      merchantId = existing[0]?.merchant_id || null;
    }

    if (existing.length) {
      await db.query(
        'UPDATE main_account SET partner_id = ?, partner_key = ?, main_account_id = ?, merchant_id = ?, updated_at = NOW() WHERE tenant_id = ? AND id = ?',
        [partnerId, partnerKey, mainAccountId, merchantId, tenantId, existing[0].id]
      );
    } else {
      await db.query(
        'INSERT INTO main_account (tenant_id, partner_id, partner_key, main_account_id, merchant_id) VALUES (?, ?, ?, ?, ?)',
        [tenantId, partnerId, partnerKey, mainAccountId, merchantId]
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[Settings] account save failed:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to save account settings' });
  }
});


const FIXED_GOOGLE_SHEET_NAMES = {
  chart: '차트',
  receipts: '입고관리',
  skuCompositions: '상품구성표',
};

function normalizeGoogleSheetId(value) {
  if (value === undefined || value === null) return '';

  const text = String(value).trim();
  if (!text) return '';

  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : text;
}

router.get('/google-sheet', async (req, res) => {
  try {
    const tenantId = getCurrentTenantId(req);

    const [rows] = await db.query(
      `SELECT
         tenant_id,
         google_sheet_id,
         last_chart_synced_at,
         last_receipt_synced_at,
         last_composition_synced_at,
         updated_at
       FROM tenant_google_sheet_settings
       WHERE tenant_id = ?
       LIMIT 1`,
      [tenantId]
    );

    const settings = rows[0] || {
      tenant_id: tenantId,
      google_sheet_id: '',
      last_chart_synced_at: null,
      last_receipt_synced_at: null,
      last_composition_synced_at: null,
      updated_at: null,
    };

    return res.json({
      success: true,
      settings: {
        ...settings,
        google_sheet_id: settings.google_sheet_id || '',
        sheet_names: FIXED_GOOGLE_SHEET_NAMES,
      },
    });
  } catch (err) {
    console.error('[Settings] Google Sheet settings load failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to load Google Sheet settings',
    });
  }
});

router.put('/google-sheet', async (req, res) => {
  try {
    const tenantId = getCurrentTenantId(req);
    const googleSheetId = normalizeGoogleSheetId(req.body?.google_sheet_id);

    if (googleSheetId && googleSheetId.length > 255) {
      return res.status(400).json({
        success: false,
        error: 'Google Sheet ID is too long',
      });
    }

    await db.query(
      `INSERT INTO tenant_google_sheet_settings
         (tenant_id, google_sheet_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         google_sheet_id = VALUES(google_sheet_id),
         updated_at = NOW()`,
      [tenantId, googleSheetId || null]
    );

    return res.json({
      success: true,
      settings: {
        tenant_id: tenantId,
        google_sheet_id: googleSheetId,
        sheet_names: FIXED_GOOGLE_SHEET_NAMES,
      },
    });
  } catch (err) {
    console.error('[Settings] Google Sheet settings save failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to save Google Sheet settings',
    });
  }
});



router.post('/google-sheet/chart/test', async (req, res) => {
  try {
    const tenantId = getCurrentTenantId(req);
    const result = await testMarginChartSheet({ tenantId });

    return res.json({
      success: true,
      result,
    });
  } catch (err) {
    console.error('[Settings] margin chart test failed:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to test margin chart sheet',
    });
  }
});

router.post('/google-sheet/chart/sync', async (req, res) => {
  try {
    const tenantId = getCurrentTenantId(req);
    const result = await syncMarginChartSheet({ tenantId });

    return res.json({
      success: true,
      result,
    });
  } catch (err) {
    console.error('[Settings] margin chart sync failed:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to sync margin chart sheet',
    });
  }
});


router.get('/shops', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const [rows] = await db.query(
    `SELECT *, COALESCE(NULLIF(alias, ''), NULLIF(shop_name, ''), CAST(shop_id AS CHAR)) AS display_name
     FROM shops
     WHERE tenant_id = ?
     ORDER BY is_active DESC, id ASC`,
    [tenantId]
  );
  return res.json({ success: true, data: rows });
});

router.post('/shops/sync-profile', async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const summary = await syncAllShopProfiles({ tenantId });
  return res.json({
    success: summary.failed === 0,
    message: summary.failed > 0
      ? `샵 정보 동기화가 완료되었습니다. 성공 ${summary.updated}건, 실패 ${summary.failed}건.`
      : '샵 정보 동기화가 완료되었습니다.',
    total: summary.total,
    updated: summary.updated,
    failed: summary.failed,
    results: summary.results,
  });
});


router.post('/shipping-labels/cleanup', async (req, res) => {
  try {
    const result = await cleanupShippingLabelFiles();
    return res.json({
      success: result.success,
      message: result.failedFiles > 0
        ? `송장 파일 정리가 완료되었지만 ${result.failedFiles}개 파일을 삭제하지 못했습니다.`
        : '송장 파일 정리가 완료되었습니다.',
      retentionDays: result.retentionDays,
      cutoffAt: result.cutoffAt,
      deletedFiles: result.deletedFiles,
      deletedBytes: result.deletedBytes,
      failedFiles: result.failedFiles,
      merged: result.merged,
      individual: result.individual,
      errors: result.errors,
    });
  } catch (err) {
    console.error('[Settings] shipping label cleanup failed:', err.message);
    return res.status(500).json({
      success: false,
      error: '송장 파일 정리에 실패했습니다.',
      retentionDays: getRetentionDays(),
    });
  }
});

// ─── 샵 정보 업데이트 ────────────────────────────────────────────
async function updateShopSettings(req, res) {
  const shopId = String(req.params?.shopId || '').trim();
  const { alias, region, is_active } = req.body || {};

  if (!/^\d+$/.test(shopId)) {
    return res.status(400).json({ success: false, error: 'Invalid shop_id' });
  }

  const tenantId = getCurrentTenantId(req);
  const [existing] = await db.query(
    'SELECT * FROM shops WHERE tenant_id = ? AND shop_id = ?',
    [tenantId, shopId]
  );

  const existingShop = existing[0];
  if (!existingShop) {
    return res.status(404).json({ success: false, error: 'Shop not found' });
  }

  const nextAlias = alias === undefined ? existingShop.alias : (String(alias || '').trim() || null);
  const nextRegion = region === undefined ? existingShop.region : (String(region || '').trim().toUpperCase() || null);
  const nextIsActive = is_active === undefined ? Number(existingShop.is_active || 0) : (is_active ? 1 : 0);
  const allowedRegions = new Set(['SG', 'MY', 'TW', 'PH', 'TH', 'VN', 'BR', 'MX']);

  if (nextRegion && !allowedRegions.has(nextRegion)) {
    return res.status(400).json({ success: false, error: 'Unsupported shop region' });
  }

  if (nextIsActive && !nextRegion) {
    return res.status(400).json({ success: false, error: 'Region is required before activating a shop' });
  }

  await db.query(
    'UPDATE shops SET alias = ?, region = ?, is_active = ?, updated_at = NOW() WHERE tenant_id = ? AND shop_id = ?',
    [nextAlias, nextRegion, nextIsActive, tenantId, shopId]
  );

  const [updatedRows] = await db.query(
    'SELECT * FROM shops WHERE tenant_id = ? AND shop_id = ? LIMIT 1',
    [tenantId, shopId]
  );

  return res.json({ success: true, message: 'Shop updated', shop: updatedRows[0] });
}

router.put('/shops/:shopId', updateShopSettings);
router.patch('/shops/:shopId', updateShopSettings);

// ─── 환율 목록 조회 ──────────────────────────────────────────────
router.get('/rates', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM exchange_rates ORDER BY currency ASC');
  return res.json({ success: true, data: rows });
});

// ─── 환율 저장 (기존 통화 업데이트) ─────────────────────────────
router.put('/rates', async (req, res) => {
  const { rates } = req.body; // [{ currency: 'SGD', rate_to_krw: 1100 }, ...]

  if (!Array.isArray(rates) || rates.length === 0) {
    return res.status(400).json({ success: false, error: 'rates array required' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rates) {
      await conn.query(
        'UPDATE exchange_rates SET rate_to_krw = ?, updated_at = NOW() WHERE currency = ?',
        [r.rate_to_krw, r.currency]
      );
    }
    await conn.commit();
    return res.json({ success: true, message: 'Exchange rates updated' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// ─── 환율 추가 ───────────────────────────────────────────────────
router.post('/rates', async (req, res) => {
  const { currency, rate_to_krw } = req.body;

  if (!currency || !rate_to_krw) {
    return res.status(400).json({ success: false, error: 'currency and rate_to_krw required' });
  }

  await db.query(
    'INSERT INTO exchange_rates (currency, rate_to_krw) VALUES (?, ?) ON DUPLICATE KEY UPDATE rate_to_krw = ?, updated_at = NOW()',
    [currency.toUpperCase(), rate_to_krw, rate_to_krw]
  );

  return res.json({ success: true, message: 'Exchange rate saved' });
});

// ─── 환율 삭제 ───────────────────────────────────────────────────
router.delete('/rates/:currency', async (req, res) => {
  const { currency } = req.params;
  const defaultCurrencies = ['SGD', 'MYR', 'TWD'];

  if (defaultCurrencies.includes(currency.toUpperCase())) {
    return res.status(400).json({ success: false, error: 'Cannot delete default currency' });
  }

  await db.query('DELETE FROM exchange_rates WHERE currency = ?', [currency.toUpperCase()]);
  return res.json({ success: true, message: 'Exchange rate deleted' });
});

module.exports = router;
