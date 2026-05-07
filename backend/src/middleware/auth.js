/**
 * JWT 인증 미들웨어
 * - 쿠키 또는 Authorization 헤더에서 JWT 검증
 */

const jwt = require('jsonwebtoken');
const { CURRENT_TENANT_ID, normalizeTenantId } = require('../config/tenant');
const db = require('../config/database');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'shopee_jwt_secret';

/**
 * JWT 토큰 생성
 */
function generateToken({ tenantId = CURRENT_TENANT_ID, userId = null, role = 'owner' } = {}) {
  const normalizedTenantId = normalizeTenantId(tenantId);

  return jwt.sign(
    {
      authenticated: true,
      tenant_id: normalizedTenantId,
      tenantId: normalizedTenantId,
      user_id: userId,
      role,
      createdAt: new Date().toISOString(),
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

/**
 * 인증 미들웨어 - 쿠키 우선, 헤더 폴백
 */
function requireAuth(req, res, next) {
  let token = null;

  // 1. 쿠키에서 토큰 추출
  if (req.cookies && req.cookies.auth_token) {
    token = req.cookies.auth_token;
  }

  // 2. Authorization 헤더에서 추출 (Bearer 토큰)
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'NO_TOKEN',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const tenantId = normalizeTenantId(
      decoded.tenant_id ??
      decoded.tenantId ??
      CURRENT_TENANT_ID
    );

    req.user = {
      ...decoded,
      tenant_id: tenantId,
      tenantId,
    };
    req.tenantId = tenantId;

    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired',
        code: 'TOKEN_EXPIRED',
      });
    }

    return res.status(401).json({
      success: false,
      error: 'Invalid token',
      code: 'INVALID_TOKEN',
    });
  }
}


async function loadTenantAccessContext(req) {
  const tenantId = normalizeTenantId(
    req?.tenantId ??
    req?.user?.tenant_id ??
    req?.user?.tenantId ??
    CURRENT_TENANT_ID
  );
  const userId = req?.user?.user_id ?? req?.user?.id ?? null;

  let isPlatformAdmin = 0;

  if (userId) {
    const [userRows] = await db.query(
      'SELECT is_platform_admin FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    isPlatformAdmin = Number(userRows[0]?.is_platform_admin || 0);
  }

  const [tenantRows] = await db.query(
    'SELECT id, approval_status, is_active FROM tenants WHERE id = ? LIMIT 1',
    [tenantId]
  );

  const tenant = tenantRows[0] || null;

  req.tenantId = tenantId;
  req.user = {
    ...(req.user || {}),
    tenant_id: tenantId,
    tenantId,
    is_platform_admin: isPlatformAdmin,
  };
  req.tenant = tenant;

  return { tenantId, tenant, isPlatformAdmin };
}

async function requireApprovedTenant(req, res, next) {
  try {
    const { tenantId, tenant } = await loadTenantAccessContext(req);

    if (!tenant) {
      return res.status(403).json({
        success: false,
        error: 'Tenant not found',
        code: 'TENANT_NOT_FOUND',
        tenant: {
          id: tenantId,
          approval_status: null,
          is_active: 0,
        },
      });
    }

    const approvalStatus = String(tenant.approval_status || '').toLowerCase();
    const isActive = Number(tenant.is_active || 0);

    if (approvalStatus === 'rejected') {
      return res.status(403).json({
        success: false,
        error: 'Tenant is rejected',
        code: 'TENANT_REJECTED',
        tenant: {
          id: tenant.id,
          approval_status: approvalStatus,
          is_active: isActive,
        },
      });
    }

    if (approvalStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Tenant is suspended',
        code: 'TENANT_SUSPENDED',
        tenant: {
          id: tenant.id,
          approval_status: approvalStatus,
          is_active: isActive,
        },
      });
    }

    if (approvalStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        error: 'Tenant approval required',
        code: 'TENANT_APPROVAL_REQUIRED',
        tenant: {
          id: tenant.id,
          approval_status: approvalStatus || 'pending',
          is_active: isActive,
        },
      });
    }

    if (isActive !== 1) {
      return res.status(403).json({
        success: false,
        error: 'Tenant is inactive',
        code: 'TENANT_INACTIVE',
        tenant: {
          id: tenant.id,
          approval_status: approvalStatus,
          is_active: isActive,
        },
      });
    }

    return next();
  } catch (err) {
    console.error('[Auth] tenant approval check failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Tenant approval check failed',
    });
  }
}


module.exports = { requireAuth, requireApprovedTenant, loadTenantAccessContext, generateToken };
