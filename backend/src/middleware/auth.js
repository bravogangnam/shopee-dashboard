/**
 * JWT 인증 미들웨어
 * - 쿠키 또는 Authorization 헤더에서 JWT 검증
 */

const jwt = require('jsonwebtoken');
const { CURRENT_TENANT_ID, normalizeTenantId } = require('../config/tenant');
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
    { expiresIn: '7d' }
  );
}

/**
 * 인증 미들웨어 - 쿠키 우선, 헤더 폴백
 */
function requireAuth(req, res, next) {
  const token =
    req.cookies?.auth_token ||
    req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
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
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth, generateToken };
