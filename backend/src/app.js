/**
 * Shopee Dashboard - Express Application
 */

require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// ─── 미들웨어 ─────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS 설정
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://45.77.173.1',
      'https://junandkang.com',
      'https://www.junandkang.com',
      'https://3000-ifdzf812k8vgi9s4visi6-2b54fc91.sandbox.novita.ai',
      'https://4000-ifdzf812k8vgi9s4visi6-2b54fc91.sandbox.novita.ai',
    ];
    // allow requests with no origin (mobile apps, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));

// ─── API 라우트 ──────────────────────────────────────────────────
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/test', require('./routes/testRoutes'));
app.use('/api/jobs', require('./routes/jobRoutes'));
app.use('/api/orders', require('./routes/ordersRoutes'));
app.use('/api/products', require('./routes/productsRoutes'));

// ─── 송장 라우트 (격리: 오류 시 기존 서비스 영향 없음) ──────────
try {
  app.use('/api/invoice', require('./routes/invoiceRoutes'));
  console.log('[App] invoiceRoutes registered');
} catch (e) {
  console.error('[App] invoiceRoutes FAILED to load — invoice disabled, orders unaffected:', e.message);
}

// ─── 헬스체크 ────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// ─── 프론트엔드 정적 파일 서빙 (production) ──────────────────────
const frontendBuild = path.join(__dirname, '../../frontend/build');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(frontendBuild));
  app.get('*', (req, res) => {
    // API 요청이 아닌 경우 React 앱 반환
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(frontendBuild, 'index.html'));
    }
  });
}

// ─── 에러 핸들러 ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.path}:`, err.message);

  // CORS error
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ success: false, error: err.message });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, error: 'Authentication failed', code: err.name });
  }

  return res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ─── 서버 시작 ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Shopee Dashboard API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);

  // 토큰 자동 갱신 Cron 시작
  const { startTokenRefreshJob } = require('./jobs/tokenRefreshJob');
  startTokenRefreshJob();

  // 자동 동기화 Cron 시작 (5분 주기, 중복 실행 lock 포함)
  try {
    const { startAutoSyncJob } = require('./jobs/autoSyncJob');
    startAutoSyncJob();
  } catch (e) {
    console.error('[App] autoSyncJob FAILED to load — auto sync disabled:', e.message);
  }

  // Google Sheet products sync (5분 주기)
  try {
    const { startGoogleSheetSyncJob } = require('./services/googleSheetSync');
    startGoogleSheetSyncJob();
  } catch (e) {
    console.error('[App] googleSheetSync FAILED to load — product sync disabled:', e.message);
  }

  // 비정상 종료된 Job 복구
  const { recoverStaleJobs } = require('./services/jobManager');
  recoverStaleJobs().catch(e => console.error('[App] recoverStaleJobs error:', e.message));
});

module.exports = app;
