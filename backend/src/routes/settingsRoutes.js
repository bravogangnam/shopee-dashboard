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
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');
const { CURRENT_TENANT_ID } = require('../config/tenant');
require('dotenv').config();

// 모든 설정 라우트에 인증 적용
router.use(requireAuth);

// ─── 계정 정보 조회 ──────────────────────────────────────────────
router.get('/account', async (req, res) => {
  const [rows] = await db.query(
    'SELECT id, partner_id, partner_key, main_account_id, merchant_id, token_status, token_expires_at, refresh_expires_at, updated_at FROM main_account LIMIT 1'
  );

  const account = rows[0] || {
    partner_id: process.env.SHOPEE_PARTNER_ID,
    partner_key: process.env.SHOPEE_PARTNER_KEY,
    main_account_id: process.env.SHOPEE_MAIN_ACCOUNT_ID,
    merchant_id: process.env.SHOPEE_MERCHANT_ID,
    token_status: null,
  };

  return res.json({ success: true, data: account });
});

// ─── 계정 정보 업데이트 ──────────────────────────────────────────
router.put('/account', async (req, res) => {
  const { partner_id, partner_key, main_account_id, merchant_id } = req.body;

  if (!partner_id || !partner_key) {
    return res.status(400).json({ success: false, error: 'partner_id and partner_key are required' });
  }

  const [existing] = await db.query('SELECT id FROM main_account LIMIT 1');

  if (existing.length > 0) {
    await db.query(
      'UPDATE main_account SET partner_id = ?, partner_key = ?, main_account_id = ?, merchant_id = ?, updated_at = NOW() WHERE id = ?',
      [partner_id, partner_key, main_account_id || null, merchant_id || null, existing[0].id]
    );
  } else {
    await db.query(
      'INSERT INTO main_account (partner_id, partner_key, main_account_id, merchant_id) VALUES (?, ?, ?, ?)',
      [partner_id, partner_key, main_account_id || null, merchant_id || null]
    );
  }

  return res.json({ success: true, message: 'Account updated' });
});

// ─── 샵 목록 조회 ───────────────────────────────────────────────
router.get('/shops', async (req, res) => {
  const tenantId = CURRENT_TENANT_ID;
  const [rows] = await db.query(
    'SELECT * FROM shops WHERE tenant_id = ? ORDER BY is_active DESC, id ASC',
    [tenantId]
  );
  return res.json({ success: true, data: rows });
});

// ─── 샵 정보 업데이트 ────────────────────────────────────────────
router.put('/shops/:shopId', async (req, res) => {
  const { shopId } = req.params;
  const { alias, region, is_active } = req.body;

  const tenantId = CURRENT_TENANT_ID;
  const [existing] = await db.query(
    'SELECT id, is_active FROM shops WHERE tenant_id = ? AND shop_id = ?',
    [tenantId, shopId]
  );
  if (!existing.length) {
    return res.status(404).json({ success: false, error: 'Shop not found' });
  }

  await db.query(
    'UPDATE shops SET alias = ?, region = ?, is_active = ?, updated_at = NOW() WHERE tenant_id = ? AND shop_id = ?',
    [alias || null, region || null, is_active !== undefined ? (is_active ? 1 : 0) : existing[0].is_active, tenantId, shopId]
  );

  return res.json({ success: true, message: 'Shop updated' });
});

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
