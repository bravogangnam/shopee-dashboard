/**
 * JWT 인증 미들웨어
 * - 쿠키 또는 Authorization 헤더에서 JWT 검증
 */

const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'shopee_jwt_secret';

/**
 * JWT 토큰 생성
 */
function generateToken() {
  return jwt.sign(
    { authenticated: true, createdAt: Date.now() },
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
    req.user = decoded;
    next();
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

module.exports = { requireAuth, generateToken };
