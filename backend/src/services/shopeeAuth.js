/**
 * Shopee OAuth 인증 서비스
 * - Authorization URL 생성
 * - Access Token / Refresh Token 발급
 * - Token 갱신
 */

const { buildUrl, getAuthUrl, PARTNER_ID } = require('../utils/shopeeSignature');
const { callWithRetry, shopeeAxios } = require('../utils/apiWrapper');
const db = require('../config/database');
const { CURRENT_TENANT_ID } = require('../config/tenant');
const { createOAuthState } = require('../utils/oauthState');
require('dotenv').config();

const REDIRECT_URL = process.env.SHOPEE_REDIRECT_URL || 'http://localhost:4000/api/auth/shopee/callback';
const MAIN_ACCOUNT_ID = parseInt(process.env.SHOPEE_MAIN_ACCOUNT_ID);
const MERCHANT_ID = parseInt(process.env.SHOPEE_MERCHANT_ID);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;

/**
 * OAuth 인증 URL 생성
 */
function getShopeeAuthUrl({ tenantId = CURRENT_TENANT_ID, purpose = 'reauth' } = {}) {
  const state = createOAuthState({ tenantId, purpose });
  return getAuthUrl(REDIRECT_URL, { state });
}

/**
 * Authorization Code → Access Token 교환
 */
async function exchangeCodeForToken(code, shopId = null, mainAccountId = null, merchantId = null) {
  const path = '/api/v2/auth/token/get';
  const url = buildUrl(path, {}, 'public');

  const body = {
    code,
    partner_id: PARTNER_ID,
  };

  if (shopId) body.shop_id = parseInt(shopId);
  if (mainAccountId) body.main_account_id = parseInt(mainAccountId);
  if (merchantId) body.merchant_id = parseInt(merchantId);

  console.log('[OAuth] exchangeCodeForToken body summary:', JSON.stringify({
    has_code: !!code,
    partner_id: PARTNER_ID,
    shop_id: body.shop_id || null,
    main_account_id: body.main_account_id || null,
    merchant_id: body.merchant_id || null,
  }));

  const response = await callWithRetry(
    () => shopeeAxios.post(url, body),
    { context: 'exchangeCodeForToken' }
  );

  return response;
}

/**
 * Access Token 갱신
 * @param {string} refreshToken
 * @param {number|null} shopId      - shop 레벨 갱신 시
 * @param {number|null} merchantId  - merchant/main-account 레벨 갱신 시
 * @param {string} [logLabel]       - 로그 식별용 레이블
 */
async function refreshAccessToken(refreshToken, shopId = null, merchantId = null, logLabel = '') {
  const path = '/api/v2/auth/access_token/get';
  const url = buildUrl(path, {}, 'public');

  const body = {
    refresh_token: refreshToken,
    partner_id: PARTNER_ID,
  };

  if (shopId)     body.shop_id     = parseInt(shopId);
  if (merchantId) body.merchant_id = parseInt(merchantId);

  const label = logLabel || (shopId ? `shop_id=${shopId}` : `merchant_id=${merchantId}`);
  console.log(`[TokenRefresh] refreshAccessToken 호출 (${label}) body=${JSON.stringify({ ...body, refresh_token: '***' })}`);

  const response = await callWithRetry(
    () => shopeeAxios.post(url, body),
    { context: `refreshAccessToken(${label})` }
  );

  // 응답 요약 로깅: access_token/refresh_token 원문 또는 일부 출력 금지
  console.log(`[TokenRefresh] refreshAccessToken 응답 (${label}):`, JSON.stringify({
    has_access_token: !!response.access_token,
    has_refresh_token: !!response.refresh_token,
    expire_in: response.expire_in || null,
    refresh_token_expire_in: response.refresh_token_expire_in || null,
    shop_id_list: response.shop_id_list || null,
  }));

  return response;
}

/**
 * DB에서 main_account 토큰 정보 가져오기
 */
async function getMainAccount({ tenantId = CURRENT_TENANT_ID } = {}) {
  const [rows] = await db.query(
    'SELECT * FROM main_account WHERE tenant_id = ? ORDER BY id DESC LIMIT 1',
    [tenantId]
  );
  return rows[0] || null;
}

/**
 * 토큰 DB 저장/업데이트
 * @param {object} tokenData  - Shopee API 응답 (access_token, refresh_token, expire_in, ...)
 * @param {number|null} authShopId - OAuth callback에서 받은 shop_id (없으면 null)
 */
async function saveToken(tokenData, authShopId = null, { tenantId = CURRENT_TENANT_ID } = {}) {
  const {
    access_token,
    refresh_token,
    expire_in,        // seconds from now for access token
    refresh_token_expire_in, // seconds from now for refresh token
  } = tokenData;

  const now = new Date();
  const tokenExpiresAt = new Date(now.getTime() + (expire_in || 14400) * 1000); // default 4h
  // Shopee refresh token은 보통 30일
  const refreshExpireDays = refresh_token_expire_in
    ? refresh_token_expire_in / 86400
    : 30;
  const refreshExpiresAt = new Date(now.getTime() + refreshExpireDays * 86400 * 1000);

  const [existing] = await db.query('SELECT id FROM main_account WHERE tenant_id = ? LIMIT 1', [tenantId]);

  if (existing.length > 0) {
    if (authShopId) {
      // callback에서 shop_id가 넘어온 경우: auth_shop_id도 함께 업데이트
      await db.query(
        `UPDATE main_account SET
          access_token = ?,
          refresh_token = ?,
          token_expires_at = ?,
          refresh_expires_at = ?,
          auth_shop_id = ?,
          token_status = 'active',
          updated_at = NOW()
         WHERE tenant_id = ? AND id = ?`,
        [access_token, refresh_token, tokenExpiresAt, refreshExpiresAt, authShopId, tenantId, existing[0].id]
      );
      console.log(`✅ Token saved (auth_shop_id=${authShopId}). Expires: ${tokenExpiresAt.toISOString()}`);
    } else {
      // refresh 갱신 등 shop_id 없는 경우: auth_shop_id는 유지
      await db.query(
        `UPDATE main_account SET
          access_token = ?,
          refresh_token = ?,
          token_expires_at = ?,
          refresh_expires_at = ?,
          token_status = 'active',
          updated_at = NOW()
         WHERE tenant_id = ? AND id = ?`,
        [access_token, refresh_token, tokenExpiresAt, refreshExpiresAt, tenantId, existing[0].id]
      );
      console.log(`✅ Token saved. Expires: ${tokenExpiresAt.toISOString()}`);
    }
  } else {
    await db.query(
      `INSERT INTO main_account
        (tenant_id, partner_id, partner_key, main_account_id, merchant_id, auth_shop_id, access_token, refresh_token, token_expires_at, refresh_expires_at, token_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [tenantId, PARTNER_ID, PARTNER_KEY, MAIN_ACCOUNT_ID, MERCHANT_ID, authShopId || null, access_token, refresh_token, tokenExpiresAt, refreshExpiresAt]
    );
    console.log(`✅ Token saved (new row, auth_shop_id=${authShopId}). Expires: ${tokenExpiresAt.toISOString()}`);
  }

  return { tokenExpiresAt, refreshExpiresAt };
}

/**
 * 토큰이 만료 임박했는지 확인
 * @param {Date} expiresAt
 * @param {number} thresholdSeconds - 만료 몇 초 전부터 갱신?
 */
function isExpiringSoon(expiresAt, thresholdSeconds) {
  if (!expiresAt) return true;
  const now = Date.now();
  const expTime = new Date(expiresAt).getTime();
  return expTime - now < thresholdSeconds * 1000;
}

/**
 * 토큰 강제 갱신 (API 403 등 토큰 무효 감지 시 즉시 호출)
 * - 만료 시간과 무관하게 무조건 갱신 시도
 * - 갱신 성공 → DB 저장 후 true 반환
 * - refresh_token도 만료 → token_status = 'expired', false 반환
 * @returns {Promise<boolean>}
 */
async function forceRefreshToken({ tenantId = CURRENT_TENANT_ID } = {}) {
  const account = await getMainAccount({ tenantId });
  if (!account) {
    console.error('[TokenRefresh] forceRefresh: No main account found.');
    return false;
  }

  const REFRESH_THRESHOLD = 5 * 86400; // 5일

  // refresh_token 만료 임박/만료 → 재인증 필요
  if (isExpiringSoon(account.refresh_expires_at, REFRESH_THRESHOLD)) {
    console.error('[TokenRefresh] ⚠️ forceRefresh: Refresh token expired or expiring soon. Re-authentication required.');
    await db.query(
      "UPDATE main_account SET token_status = 'expired' WHERE tenant_id = ? AND id = ?",
      [tenantId, account.id]
    );
    return false;
  }

  console.log('[TokenRefresh] 🔄 forceRefresh: Forcing token refresh regardless of expiry...');

  // ── Shopee access_token/get 파라미터 규칙 ───────────────────────
  // shop_id   전달 → shop-level 토큰 → shop API 정상 ✅
  // merchant_id 전달 → merchant-level 토큰 → shop API 403 ❌
  // main_account_id를 merchant_id 자리에 전달 → merchant_no_linked ❌
  // 따라서: shop_id 우선 시도 → merchant_id fallback

  // DB에서 활성 shop_id 목록 조회
  const [shopRows] = await db.query('SELECT shop_id FROM shops WHERE tenant_id = ? AND is_active = 1 ORDER BY shop_id LIMIT 3', [tenantId]);
  const activeShopIds = shopRows.map(r => r.shop_id);

  const merchantId = account.merchant_id || null;

  // 시도 순서: 활성 shop_id들(각각) → merchant_id(fallback)
  const candidates = [];
  for (const sid of activeShopIds) {
    candidates.push({ shopId: sid, merchantId: null, label: `shop_id=${sid}` });
  }
  if (merchantId) candidates.push({ shopId: null, merchantId, label: `merchant_id=${merchantId}(fallback)` });
  if (candidates.length === 0) candidates.push({ shopId: null, merchantId: null, label: 'no_id' });

  console.log(`[TokenRefresh] forceRefresh 시도 순서: ${candidates.map(c => c.label).join(' → ')}`);

  for (const cand of candidates) {
    try {
      const result = await refreshAccessToken(
        account.refresh_token,
        cand.shopId,
        cand.merchantId,
        cand.label
      );

      if (result.access_token) {
        await saveToken(result, null); // auth_shop_id 변경 없이 토큰만 갱신
        console.log(`✅ [TokenRefresh] forceRefresh 성공 (${cand.label}). shop_id_list=${JSON.stringify(result.shop_id_list ?? 'N/A')}`);
        return true;
      }

      console.warn(`[TokenRefresh] forceRefresh (${cand.label}): access_token 없음, 다음 시도...`);
    } catch (err) {
      // Shopee API 에러 응답 body 파싱
      const responseBody = err.response?.data || {};
      const shopeeError  = responseBody.error  || '';
      const shopeeMsg    = responseBody.message || err.message || '';

      console.error(`❌ [TokenRefresh] forceRefresh (${cand.label}) 실패: ${shopeeMsg} (shopeeError=${shopeeError})`);

      // refresh_token 자체 만료인 경우만 즉시 중단
      const isRefreshTokenDead =
        shopeeError.includes('refresh_token') ||
        (shopeeMsg.toLowerCase().includes('refresh token') &&
         (shopeeMsg.toLowerCase().includes('expired') || shopeeMsg.toLowerCase().includes('invalid')));

      if (isRefreshTokenDead) {
        console.error('[TokenRefresh] ❌ Refresh token is dead. Marking as expired.');
        await db.query("UPDATE main_account SET token_status = 'expired' WHERE tenant_id = ? AND id = ?", [tenantId, account.id]);
        return false;
      }
      // 그 외 에러(error_param, merchant_no_linked 등)는 다음 candidate 시도
    }
  }

  console.error('[TokenRefresh] ❌ forceRefresh: 모든 시도 실패.');
  return false;
}

/**
 * 토큰 자동 갱신 (3회 재시도, 5분 간격)
 * - 만료 30분 전부터 무조건 갱신 (기존 1시간 → 30분으로 단축)
 */
async function autoRefreshToken({ tenantId = CURRENT_TENANT_ID } = {}) {
  const account = await getMainAccount({ tenantId });
  if (!account) {
    console.log('[TokenRefresh] No main account found, skipping...');
    return false;
  }

  const ACCESS_THRESHOLD = 30 * 60;    // 30분 전 갱신 (기존 1시간 → 30분)
  const REFRESH_THRESHOLD = 5 * 86400; // 5일 전 알림

  // refresh_token 만료 임박 → 알림 (재발급 불가, OAuth 재인증 필요)
  if (isExpiringSoon(account.refresh_expires_at, REFRESH_THRESHOLD)) {
    console.warn('[TokenRefresh] ⚠️ Refresh token expiring within 5 days! Re-authentication required.');
    await db.query(
      "UPDATE main_account SET token_status = 'expired' WHERE tenant_id = ? AND id = ?",
      [tenantId, account.id]
    );
    return false;
  }

  // access_token 만료 30분 전부터 갱신
  if (isExpiringSoon(account.token_expires_at, ACCESS_THRESHOLD)) {
    const remaining = Math.round((new Date(account.token_expires_at) - Date.now()) / 60000);
    console.log(`[TokenRefresh] Access token expiring in ~${remaining}min, refreshing...`);

    // ── shop_id 우선 시도, merchant_id fallback ─────────────────
    // Shopee access_token/get: shop_id 전달 시 shop-level 토큰 반환
    const [shopRows] = await db.query('SELECT shop_id FROM shops WHERE tenant_id = ? AND is_active = 1 ORDER BY shop_id LIMIT 3', [tenantId]);
    const activeShopIds = shopRows.map(r => r.shop_id);
    const merchantId = account.merchant_id || null;

    const candidates = [];
    for (const sid of activeShopIds) {
      candidates.push({ shopId: sid, merchantId: null, label: `shop_id=${sid}` });
    }
    if (merchantId) candidates.push({ shopId: null, merchantId, label: `merchant_id=${merchantId}(fallback)` });
    if (candidates.length === 0) candidates.push({ shopId: null, merchantId: null, label: 'no_id' });

    console.log(`[TokenRefresh] autoRefresh 시도 순서: ${candidates.map(c => c.label).join(' → ')}`);

    const maxRetries = candidates.length;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const cand = candidates[attempt];
      try {
        const result = await refreshAccessToken(
          account.refresh_token,
          cand.shopId,
          cand.merchantId,
          `autoRefresh(${cand.label})`
        );

        if (result.access_token) {
          await saveToken(result, null); // auth_shop_id 변경 없이 토큰만 갱신
          console.log(`✅ [TokenRefresh] Token refreshed (${cand.label}). shop_id_list=${JSON.stringify(result.shop_id_list ?? 'N/A')}`);
          return true;
        }
        console.warn(`[TokenRefresh] autoRefresh (${cand.label}): access_token 없음, 다음 시도...`);
      } catch (err) {
        const responseBody = err.response?.data || {};
        const shopeeError  = responseBody.error  || '';
        const shopeeMsg    = responseBody.message || err.message || '';
        console.error(`❌ [TokenRefresh] autoRefresh (${cand.label}) 실패: ${shopeeMsg} (shopeeError=${shopeeError})`);

        // refresh_token 자체 만료 → 즉시 중단
        const isRefreshTokenDead =
          shopeeError.includes('refresh_token') ||
          (shopeeMsg.toLowerCase().includes('refresh token') &&
           (shopeeMsg.toLowerCase().includes('expired') || shopeeMsg.toLowerCase().includes('invalid')));

        if (isRefreshTokenDead) {
          await db.query("UPDATE main_account SET token_status = 'expired' WHERE tenant_id = ? AND id = ?", [tenantId, account.id]);
          console.error('❌ [TokenRefresh] Refresh token dead. Token marked as expired.');
          return false;
        }
        // 다른 에러 → 다음 candidate 시도
      }
    }

    // 모든 candidate 실패
    await db.query("UPDATE main_account SET token_status = 'expired' WHERE tenant_id = ? AND id = ?", [tenantId, account.id]);
    console.error('❌ [TokenRefresh] All candidates failed. Token marked as expired.');
    return false;
  }

  const remaining = Math.round((new Date(account.token_expires_at) - Date.now()) / 60000);
  console.log(`[TokenRefresh] Token valid for ~${remaining}min, no refresh needed.`);
  return true;
}

// ════════════════════════════════════════════════════════════
// ■ Shop별 토큰 관리
//   Shopee access_token/get 에 shop_id를 전달하면
//   해당 shop 전용 토큰만 발급됨 → shops 테이블에 shop별 저장
// ════════════════════════════════════════════════════════════

/**
 * shops 테이블에서 특정 shop의 access_token 조회
 * @param {number} shopId
 * @returns {string|null}
 */
async function getShopToken(shopId, { tenantId = CURRENT_TENANT_ID } = {}) {
  const [rows] = await db.query(
    'SELECT access_token, token_expires_at, token_status FROM shops WHERE tenant_id = ? AND shop_id = ?',
    [tenantId, shopId]
  );
  if (!rows[0]) return null;
  return rows[0].access_token || null;
}

/**
 * shops 테이블에 특정 shop의 토큰 저장/갱신
 * @param {number} shopId
 * @param {object} tokenData  - { access_token, refresh_token, expire_in }
 */
async function saveShopToken(shopId, tokenData, { tenantId = CURRENT_TENANT_ID } = {}) {
  const { access_token, refresh_token, expire_in } = tokenData;
  const tokenExpiresAt = new Date(Date.now() + (expire_in || 14400) * 1000);

  const [result] = await db.query(
    `UPDATE shops SET
       access_token     = ?,
       refresh_token    = ?,
       token_expires_at = ?,
       token_status     = 'active',
       updated_at       = NOW()
     WHERE tenant_id = ? AND shop_id = ?`,
    [access_token, refresh_token || null, tokenExpiresAt, tenantId, shopId]
  );

  if (result.affectedRows === 0) {
    console.warn(`⚠️ [ShopToken] shop_id=${shopId} 는 shops 테이블에 없음 — 저장 스킵`);
    return false;
  }
  console.log(`✅ [ShopToken] shop_id=${shopId} 토큰 저장. 만료: ${tokenExpiresAt.toISOString()}`);
  return true;
}

/**
 * 특정 shop의 토큰을 강제 갱신
 * - 우선순위: ① shops 테이블의 shop별 refresh_token + shop_id
 *             ② main_account.refresh_token + shop_id (fallback)
 * - Shopee 토큰은 OAuth 인증 시 발급된 shop에 귀속됨 →
 *   shop별 refresh_token이 있어야만 해당 shop 갱신 가능
 * @param {number} shopId
 * @returns {Promise<boolean>}
 */
async function refreshShopToken(shopId, { tenantId = CURRENT_TENANT_ID } = {}) {
  const account = await getMainAccount({ tenantId });
  if (!account) {
    console.error(`[ShopToken] refreshShopToken(${shopId}): main_account 없음`);
    return false;
  }

  // shops 테이블에서 해당 shop의 refresh_token 조회
  const [shopRows] = await db.query(
    'SELECT refresh_token, token_status FROM shops WHERE tenant_id = ? AND shop_id = ?',
    [tenantId, shopId]
  );
  const shopRow = shopRows[0];
  const shopRefreshToken = shopRow?.refresh_token || null;

  // ── 사용할 refresh_token 결정 ────────────────────────────────
  // 1순위: shops 테이블의 shop 전용 refresh_token
  // 2순위: main_account.refresh_token (fallback — SG 전용이라 MY/TW엔 실패 가능)
  let refreshToken = null;
  let refreshSource = '';

  if (shopRefreshToken) {
    refreshToken  = shopRefreshToken;
    refreshSource = `shops.refresh_token(shop_id=${shopId})`;
  } else if (account.refresh_token) {
    refreshToken  = account.refresh_token;
    refreshSource = `main_account.refresh_token(fallback)`;
    console.warn(`[ShopToken] shop_id=${shopId}: shop 전용 refresh_token 없음 — main_account.refresh_token으로 시도 (실패 가능성 높음)`);
  } else {
    console.error(`[ShopToken] refreshShopToken(${shopId}): 사용 가능한 refresh_token 없음 — OAuth 재인증 필요`);
    return false;
  }

  // refresh_token 만료 체크 (5일 이내, main_account 기준)
  if (refreshSource.includes('fallback') && isExpiringSoon(account.refresh_expires_at, 5 * 86400)) {
    console.error(`[ShopToken] refreshShopToken(${shopId}): main_account refresh_token 만료 임박 — 재인증 필요`);
    return false;
  }

  console.log(`[ShopToken] refreshShopToken(${shopId}) 시작 — 사용 토큰: ${refreshSource}`);

  try {
    const label = `shop_id=${shopId}`;
    const result = await refreshAccessToken(
      refreshToken,
      shopId,  // shop_id 전달 → shop 전용 토큰 발급
      null,    // merchant_id 없음
      label
    );

    if (result?.access_token) {
      await saveShopToken(shopId, result, { tenantId });
      console.log(`✅ [ShopToken] shop_id=${shopId} 갱신 성공 (${refreshSource})`);
      return true;
    }

    console.warn(`[ShopToken] refreshShopToken(${shopId}): access_token 없음 — 응답: ${JSON.stringify(result)}`);
    return false;
  } catch (err) {
    const responseBody = err.response?.data || {};
    const shopeeError  = responseBody.error  || '';
    const shopeeMsg    = responseBody.message || err.message || '';
    const statusCode   = err.response?.status || 'N/A';
    console.error(`❌ [ShopToken] refreshShopToken(${shopId}) 실패 [HTTP ${statusCode}]: ${shopeeMsg} (error=${shopeeError}, source=${refreshSource})`);
    console.error(`❌ [ShopToken] 응답 전체: ${JSON.stringify(responseBody)}`);

    // refresh_token 자체 만료 → main_account expired 마킹
    const isRefreshDead =
      shopeeError.includes('refresh_token') ||
      (shopeeMsg.toLowerCase().includes('refresh token') &&
       (shopeeMsg.toLowerCase().includes('expired') || shopeeMsg.toLowerCase().includes('invalid')));
    if (isRefreshDead) {
      console.error(`❌ [ShopToken] Refresh token dead for shop_id=${shopId}. 해당 shop 재인증 필요.`);
      // shop 상태만 none으로 변경 (main_account 전체는 건드리지 않음)
      await db.query(
        "UPDATE shops SET token_status = 'none' WHERE tenant_id = ? AND shop_id = ?",
        [tenantId, shopId]
      );
    }
    return false;
  }
}

/**
 * 모든 활성 shop의 토큰을 순차 갱신
 * - tokenRefreshJob에서 3시간마다 호출
 * @returns {Promise<{success: number, fail: number}>}
 */
async function refreshAllShopTokens({ tenantId = CURRENT_TENANT_ID } = {}) {
  const [shops] = await db.query(
    'SELECT shop_id, region FROM shops WHERE tenant_id = ? AND is_active = 1 ORDER BY id ASC',
    [tenantId]
  );
  let success = 0, fail = 0;

  for (const shop of shops) {
    console.log(`[ShopToken] 갱신 시도: shop_id=${shop.shop_id} (${shop.region})`);
    const ok = await refreshShopToken(shop.shop_id, { tenantId });
    if (ok) success++;
    else     fail++;
    // Shopee rate-limit 방지 — shop 간 0.5초 간격
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[ShopToken] 전체 갱신 완료: 성공=${success}, 실패=${fail}`);
  return { success, fail };
}

/**
 * shop 토큰 조회 + 만료 임박 시 자동 갱신
 * - shopOrder/shopLogistics에서 토큰 취득 시 사용
 * @param {number} shopId
 * @returns {Promise<string|null>}
 */
async function getOrRefreshShopToken(shopId, { tenantId = CURRENT_TENANT_ID } = {}) {
  const [rows] = await db.query(
    'SELECT access_token, token_expires_at, token_status FROM shops WHERE tenant_id = ? AND shop_id = ?',
    [tenantId, shopId]
  );
  const shop = rows[0];

  // 토큰 없거나 만료 5분 이내 → 즉시 갱신
  if (!shop?.access_token || shop.token_status !== 'active' ||
      isExpiringSoon(shop.token_expires_at, 5 * 60)) {
    console.log(`[ShopToken] shop_id=${shopId} 토큰 없음/만료 임박 — 갱신 중...`);
    const ok = await refreshShopToken(shopId, { tenantId });
    if (!ok) return null;
    // 갱신 후 재조회
    const [fresh] = await db.query('SELECT access_token FROM shops WHERE tenant_id = ? AND shop_id = ?', [tenantId, shopId]);
    return fresh[0]?.access_token || null;
  }

  return shop.access_token;
}

module.exports = {
  getShopeeAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  forceRefreshToken,
  getMainAccount,
  saveToken,
  isExpiringSoon,
  autoRefreshToken,
  // ── shop별 토큰 ──
  getShopToken,
  saveShopToken,
  refreshShopToken,
  refreshAllShopTokens,
  getOrRefreshShopToken,
};
