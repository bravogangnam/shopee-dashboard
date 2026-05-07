/**
 * 인증 라우트
 * POST /api/auth/login         - 비밀번호 인증 → JWT 발급
 * GET  /api/auth/shopee/url    - Shopee OAuth URL 반환
 * GET  /api/auth/shopee/callback - OAuth 콜백 처리
 * POST /api/auth/shopee/refresh - 토큰 수동 갱신
 * GET  /api/auth/status         - 현재 토큰 상태 확인
 * POST /api/auth/logout         - 로그아웃
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { generateToken, requireAuth, requireApprovedTenant, loadTenantAccessContext } = require('../middleware/auth');
const {
  getShopeeAuthUrl,
  exchangeCodeForToken,
  getMainAccount,
  saveToken,
  saveShopToken,
  refreshAllShopTokens,
  autoRefreshToken,
} = require('../services/shopeeAuth');
const db = require('../config/database');
const { verifyOAuthState } = require('../utils/oauthState');
const { getCurrentTenantId } = require('../config/tenant');
require('dotenv').config();

function setAuthCookie(res, token) {
  res.cookie('auth_token', token, {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}


function normalizeRegisterPayload(body = {}) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const requestedMainAccountIdRaw = body.requested_main_account_id ?? body.requestedMainAccountId;
  const requestedMainAccountIdText = String(requestedMainAccountIdRaw ?? '').trim();
  const phone = typeof body.phone === 'string' ? body.phone.trim() : null;

  return { email, password, requestedMainAccountIdText, phone };
}

function validateRegisterPayload(payload) {
  const errors = [];
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!payload.email) {
    errors.push('email is required');
  } else if (!emailRegex.test(payload.email)) {
    errors.push('email format is invalid');
  }

  if (!payload.password) {
    errors.push('password is required');
  } else if (payload.password.length < 8) {
    errors.push('password must be at least 8 characters');
  }

  if (!payload.requestedMainAccountIdText) {
    errors.push('requested_main_account_id is required');
  } else if (!/^\d+$/.test(payload.requestedMainAccountIdText)) {
    errors.push('requested_main_account_id must be numeric');
  } else if (BigInt(payload.requestedMainAccountIdText) <= 0n) {
    errors.push('requested_main_account_id must be greater than 0');
  }

  if (payload.phone && payload.phone.length > 50) {
    errors.push('phone must be 50 characters or fewer');
  }

  return errors;
}


// ─── 로그인 ─────────────────────────────────────────────────────
// 기존 APP_PASSWORD 로그인은 그대로 유지.
// email이 같이 오면 users/tenant_users 기반 로그인도 지원.
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const APP_PASSWORD = process.env.APP_PASSWORD || '976431';

  if (!password) {
    return res.status(400).json({ success: false, error: 'Password required' });
  }

  const normalizedEmail = typeof email === 'string'
    ? email.trim().toLowerCase()
    : '';

  if (normalizedEmail) {
    try {
      const [rows] = await db.query(
        `SELECT
           u.id AS user_id,
           u.email,
           u.password_hash,
           u.display_name,
           tu.tenant_id,
           tu.role
         FROM users u
         JOIN tenant_users tu ON tu.user_id = u.id
         JOIN tenants t ON t.id = tu.tenant_id
         WHERE u.email = ?
           AND u.is_active = 1
           AND tu.is_active = 1
         ORDER BY
           CASE tu.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'staff' THEN 3 ELSE 4 END,
           tu.tenant_id ASC
         LIMIT 1`,
        [normalizedEmail]
      );

      const user = rows[0];

      if (!user || !user.password_hash) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      const passwordMatches = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatches) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      await db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.user_id]);

      const token = generateToken({
        tenantId: user.tenant_id,
        userId: user.user_id,
        role: user.role || 'owner',
      });

      setAuthCookie(res, token);

      return res.json({
        success: true,
        message: 'Login successful',
        token,
        user: {
          id: user.user_id,
          email: user.email,
          display_name: user.display_name,
          tenant_id: user.tenant_id,
          role: user.role,
        },
      });
    } catch (err) {
      console.error('[Auth] email login failed:', err.message);
      return res.status(500).json({ success: false, error: 'Login failed' });
    }
  }

  // 기존 단일 비밀번호 로그인 fallback
  if (password !== APP_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

  const token = generateToken();
  setAuthCookie(res, token);

  return res.json({
    success: true,
    message: 'Login successful',
    token,
  });
});


router.post('/register', async (req, res) => {
  const payload = normalizeRegisterPayload(req.body || {});
  const errors = validateRegisterPayload(payload);

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors,
    });
  }

  const requestedMainAccountIdText = payload.requestedMainAccountIdText;
  const tenantCode = `MAIN_${requestedMainAccountIdText}`;
  const tenantName = `Main Account ${requestedMainAccountIdText}`;
  const displayName = payload.email.includes('@') ? payload.email.split('@')[0] : payload.email;
  const tenantIdLockName = 'shopee_dashboard:tenant_id_sequence';

  const conn = await db.getConnection();
  let lockAcquired = false;

  try {
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS gotLock', [tenantIdLockName]);
    if (Number(lockRows[0]?.gotLock) !== 1) {
      return res.status(503).json({
        success: false,
        error: 'Registration is temporarily busy. Please try again.',
      });
    }
    lockAcquired = true;

    await conn.beginTransaction();

    const [dupUsers] = await conn.query(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [payload.email]
    );

    if (dupUsers.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        error: 'Email already exists',
      });
    }

    const [dupTenantCode] = await conn.query(
      'SELECT id FROM tenants WHERE code = ? LIMIT 1',
      [tenantCode]
    );

    if (dupTenantCode.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        error: 'Main account request already exists',
      });
    }

    const [dupMainAccount] = await conn.query(
      'SELECT id FROM tenants WHERE requested_main_account_id = ? LIMIT 1',
      [requestedMainAccountIdText]
    );

    if (dupMainAccount.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        error: 'Main account request already exists',
      });
    }

    const [lastTenantRows] = await conn.query(
      'SELECT id FROM tenants ORDER BY id DESC LIMIT 1 FOR UPDATE'
    );
    const tenantId = Number(lastTenantRows[0]?.id || 0) + 1;

    await conn.query(
      `INSERT INTO tenants
        (
          id,
          code,
          name,
          requested_main_account_id,
          approval_status,
          is_active,
          approved_at,
          approved_by_user_id,
          rejected_at,
          rejection_reason
        )
       VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL)`,
      [tenantId, tenantCode, tenantName, requestedMainAccountIdText]
    );

    const passwordHash = await bcrypt.hash(payload.password, 12);

    const [userResult] = await conn.query(
      `INSERT INTO users
        (
          email,
          password_hash,
          display_name,
          phone,
          is_active,
          is_platform_admin,
          last_login_at
        )
       VALUES (?, ?, ?, ?, 1, 0, NULL)`,
      [payload.email, passwordHash, displayName || payload.email, payload.phone || null]
    );

    const userId = userResult.insertId;

    await conn.query(
      `INSERT INTO tenant_users
        (tenant_id, user_id, role, is_active)
       VALUES (?, ?, 'owner', 1)`,
      [tenantId, userId]
    );

    await conn.commit();

    return res.status(201).json({
      success: true,
      message: 'Registration submitted. Admin approval is required.',
      tenant: {
        id: tenantId,
        code: tenantCode,
        name: tenantName,
        requested_main_account_id: requestedMainAccountIdText,
        approval_status: 'pending',
        is_active: 0,
      },
      user: {
        id: userId,
        email: payload.email,
        display_name: displayName || payload.email,
        phone: payload.phone || null,
        is_platform_admin: 0,
      },
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}

    console.error('[Auth] register failed:', err.message);

    return res.status(500).json({
      success: false,
      error: 'Registration failed',
    });
  } finally {
    if (lockAcquired) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [tenantIdLockName]);
      } catch (err) {
        console.error('[Auth] register lock release failed:', err.message);
      }
    }

    conn.release();
  }
});


// ─── 로그아웃 ────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token');
  return res.json({ success: true, message: 'Logged out' });
});

// ─── Shopee OAuth URL 생성 ───────────────────────────────────────
router.get('/shopee/url', requireAuth, requireApprovedTenant, (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const url = getShopeeAuthUrl({ tenantId });
  return res.json({ success: true, url });
});

// ─── Shopee OAuth Callback ──────────────────────────────────────
router.get('/shopee/callback', async (req, res) => {
  const { code, shop_id, main_account_id, merchant_id, state } = req.query;
  const stateResult = verifyOAuthState(state);
  const tenantId = stateResult.tenantId;

  if (!stateResult.valid) {
    console.warn(`[OAuth] state invalid or missing: ${stateResult.reason}; rejecting callback`);
    return res.status(400).send(`
      <html>
      <head><title>Auth Error</title></head>
      <body style="font-family:Arial;text-align:center;padding:50px;">
        <h2 style="color:red;">❌ 인증 실패</h2>
        <p>OAuth state is invalid or expired. Please try Shopee authorization again.</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({
              type: 'SHOPEE_AUTH_ERROR',
              error: 'Invalid or expired OAuth state'
            }, '*');
            setTimeout(() => window.close(), 3000);
          } else {
            setTimeout(() => { window.location.href = '/settings?auth=error'; }, 3000);
          }
        </script>
      </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html><body>
        <h2>Authorization Failed</h2>
        <p>No authorization code received.</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'SHOPEE_AUTH_ERROR', error: 'No code' }, '*');
            window.close();
          } else {
            window.location.href = '/?auth=error';
          }
        </script>
      </body></html>
    `);
  }

  try {
    // ── 콜백 파라미터 전체 상세 로깅 ───────────────────────────
    console.log('[OAuth] ===== CALLBACK PARAMS =====');
    console.log(`[OAuth]   code          : ${code?.slice(0, 15)}...`);
    console.log(`[OAuth]   shop_id       : ${shop_id ?? '(없음)'}`);
    console.log(`[OAuth]   merchant_id   : ${merchant_id ?? '(없음)'}`);
    console.log(`[OAuth]   main_account_id: ${main_account_id ?? '(없음)'}`);
    console.log(`[OAuth]   raw query     : ${JSON.stringify(req.query)}`);
    console.log('[OAuth] ==================================');

    // shop_id, main_account_id, merchant_id 중 실제로 온 값으로 토큰 교환
    const useShopId      = shop_id      ? parseInt(shop_id)      : null;
    const useMerchantId  = merchant_id  ? parseInt(merchant_id)  : null;
    // main_account_id는 Shopee가 merchant_id 대신 보내는 경우 있음
    const useMainAcctId  = (!useMerchantId && main_account_id)
      ? parseInt(main_account_id)
      : null;

    console.log(`[OAuth] exchangeCodeForToken → shop_id=${useShopId}, merchantId=${useMerchantId ?? useMainAcctId}`);

    const result = await exchangeCodeForToken(
      code,
      useShopId,
      useMerchantId ?? useMainAcctId  // merchant_id 없으면 main_account_id 시도
    );

    // ── 응답 전체 로깅 (토큰 타입 확인용) ──────────────────────
    console.log('[OAuth] ===== TOKEN RESPONSE =====');
    console.log(`[OAuth]   access_token  : ${result.access_token?.slice(0, 20)}...`);
    console.log(`[OAuth]   expire_in     : ${result.expire_in}`);
    console.log(`[OAuth]   refresh_expire: ${result.refresh_token_expire_in}`);
    console.log(`[OAuth]   merchant_id_r : ${result.merchant_id_list ?? result.merchant_id ?? '(없음)'}`);
    console.log(`[OAuth]   shop_id_list  : ${JSON.stringify(result.shop_id_list ?? '(없음)')}`);
    console.log(`[OAuth]   full response : ${JSON.stringify(result)}`);
    console.log('[OAuth] ==================================');

    if (!result.access_token) {
      throw new Error(`No access_token in response: ${JSON.stringify(result)}`);
    }

    // ── main_account 토큰 저장 ──────────────────────────────────
    const callbackShopId = useShopId;
    await saveToken(result, callbackShopId, { tenantId });

    const oauthMainAccountId = main_account_id || result.main_account_id || null;
    const oauthMerchantId = merchant_id || result.merchant_id || (
      Array.isArray(result.merchant_id_list) && result.merchant_id_list.length
        ? result.merchant_id_list[0]
        : null
    );

    if (oauthMainAccountId || oauthMerchantId) {
      await db.query(
        `UPDATE main_account
         SET
           main_account_id = COALESCE(?, main_account_id),
           merchant_id = COALESCE(?, merchant_id),
           updated_at = NOW()
         WHERE tenant_id = ?`,
        [
          oauthMainAccountId ? String(oauthMainAccountId) : null,
          oauthMerchantId ? String(oauthMerchantId) : null,
          tenantId,
        ]
      );
    }

    if (oauthMainAccountId) {
      await db.query(
        'UPDATE tenants SET requested_main_account_id = ? WHERE id = ?',
        [String(oauthMainAccountId), tenantId]
      );
    }

    console.log(`✅ Shopee OAuth completed, main_account token saved. auth_shop_id=${callbackShopId || 'none'}`);

    // ── 응답의 shop_id_list → shops 테이블에 동일 토큰 저장 ─────
    // Shopee main_account 인증 시 shop_id_list에 연결된 shop들이 반환됨
    // 이 토큰은 해당 모든 shop API 호출에 사용 가능
    const shopIdList = Array.isArray(result.shop_id_list) ? result.shop_id_list : [];
    if (callbackShopId && !shopIdList.includes(callbackShopId)) {
      shopIdList.push(callbackShopId); // 콜백에 shop_id가 직접 온 경우도 포함
    }

    const savedShopIds = [];
    for (const sid of shopIdList) {
      try {
        const saved = await saveShopToken(sid, result, { tenantId });
        if (saved) savedShopIds.push(sid);
      } catch (e) {
        console.error(`[OAuth] shops 저장 실패 (shop_id=${sid}):`, e.message);
      }
    }
    console.log(`[OAuth] shop_id_list=${JSON.stringify(shopIdList)}, shops 테이블 저장 완료=${JSON.stringify(savedShopIds)}`);

    // 나머지 미인증 shop 확인
    const [allShops] = await db.query(
      'SELECT shop_id, region, alias, token_status FROM shops WHERE tenant_id = ? AND is_active=1 ORDER BY id',
      [tenantId]
    );
    const pendingShops = allShops.filter(s => s.token_status !== 'active');
    const allAuthed    = pendingShops.length === 0;

    console.log(`[OAuth] shop 인증 현황: 전체=${allShops.length}, 미완료=${pendingShops.length}`);

    // 팝업이면 메시지 후 닫기, 아니면 설정 페이지로 리다이렉트
    return res.send(`
      <html>
      <head><title>Shopee Authorization</title></head>
      <body style="font-family:Arial;text-align:center;padding:50px;">
        <h2 style="color:#1677FF;">✅ 인증 완료!</h2>
        <p>Shopee 계정 연결이 완료되었습니다.</p>
        ${savedShopIds.length > 0
          ? `<p style="color:#52c41a;">✅ Shop 토큰 저장: ${savedShopIds.join(', ')}</p>`
          : ''}
        ${!allAuthed ? `
        <div style="background:#fff3cd;border:1px solid #ffc107;padding:15px;border-radius:8px;margin:20px auto;max-width:400px;text-align:left;">
          <b>⚠️ 아직 인증이 필요한 Shop:</b><br>
          ${pendingShops.map(s => `• ${s.alias || s.region} (${s.shop_id})`).join('<br>')}<br><br>
          <small>Settings 화면에서 각 shop별로 "Shopee 연동" 버튼을 클릭해 주세요.</small>
        </div>` : '<p style="color:#52c41a;">🎉 모든 Shop 인증 완료!</p>'}
        <p style="color:#888;">이 창은 자동으로 닫힙니다...</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'SHOPEE_AUTH_SUCCESS', shopIds: ${JSON.stringify(savedShopIds)} }, '*');
            setTimeout(() => window.close(), 3000);
          } else {
            setTimeout(() => { window.location.href = '/settings?auth=success'; }, 3000);
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[OAuth] Token exchange failed:', err.message);

    return res.status(500).send(`
      <html>
      <head><title>Auth Error</title></head>
      <body style="font-family:Arial;text-align:center;padding:50px;">
        <h2 style="color:red;">❌ 인증 실패</h2>
        <p>${err.message}</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'SHOPEE_AUTH_ERROR', error: '${err.message.replace(/'/g, "\\'")}' }, '*');
            setTimeout(() => window.close(), 3000);
          } else {
            setTimeout(() => { window.location.href = '/settings?auth=error'; }, 3000);
          }
        </script>
      </body>
      </html>
    `);
  }
});

// ─── 토큰 수동 갱신 ──────────────────────────────────────────────
router.post('/shopee/refresh', requireAuth, requireApprovedTenant, async (req, res) => {
  try {
    const tenantId = getCurrentTenantId(req);
    const success = await autoRefreshToken({ tenantId });
    const account = await getMainAccount({ tenantId });

    return res.json({
      success: true,
      refreshed: success,
      status: account?.token_status,
      expires_at: account?.token_expires_at,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 토큰 상태 확인 ──────────────────────────────────────────────
router.get('/status', requireAuth, requireApprovedTenant, async (req, res) => {
  const tenantId = getCurrentTenantId(req);
  const account = await getMainAccount({ tenantId });

  if (!account) {
    return res.json({
      success: true,
      authenticated: false,
      token_status: null,
      message: 'No account configured',
    });
  }

  return res.json({
    success: true,
    authenticated: !!account.access_token,
    token_status: account.token_status,
    token_expires_at: account.token_expires_at,
    refresh_expires_at: account.refresh_expires_at,
    partner_id: account.partner_id,
    main_account_id: account.main_account_id,
    merchant_id: account.merchant_id,
  });
});

// ─── 인증 상태 확인 (세션 체크용) ──────────────────────────────
router.get('/check', requireAuth, async (req, res) => {
  try {
    const { tenantId, tenant, isPlatformAdmin } = await loadTenantAccessContext(req);

    return res.json({
      success: true,
      authenticated: true,
      tenant_id: tenantId,
      approval_status: tenant?.approval_status || null,
      tenant_is_active: tenant ? Number(tenant.is_active || 0) : null,
      is_platform_admin: Number(isPlatformAdmin || 0),
    });
  } catch (err) {
    console.error('[Auth] check failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Auth check failed',
    });
  }
});

module.exports = router;
