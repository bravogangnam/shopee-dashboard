#!/bin/bash
set -euo pipefail

APP_DIR="/var/www/shopee-dashboard"
BACKEND_DIR="$APP_DIR/backend"
FRONTEND_DIR="$APP_DIR/frontend"
FRONTEND_BUILD_DIR="$FRONTEND_DIR/build"
FRONTEND_TMP_BUILD_DIR="$FRONTEND_DIR/unified-build"
PM2_APP_NAME="shopee-backend"

echo "== Deploy started =="

cd "$APP_DIR"

echo "== Pull latest code =="
git pull --ff-only origin main

echo "== Install frontend dependencies =="
cd "$FRONTEND_DIR"
npm install

echo "== Build frontend =="
rm -rf "$FRONTEND_TMP_BUILD_DIR"
npm run build -- --outDir unified-build --base /

if [ ! -f "$FRONTEND_TMP_BUILD_DIR/index.html" ]; then
  echo "ERROR: frontend build failed; index.html not found"
  exit 1
fi

echo "== Replace frontend build =="
cd "$APP_DIR"
if [ -d "$FRONTEND_BUILD_DIR" ]; then
  BUILD_BACKUP="$FRONTEND_DIR/build-backup-deploy-$(date +%Y%m%d_%H%M%S)"
  mv "$FRONTEND_BUILD_DIR" "$BUILD_BACKUP"
  echo "frontend build backup: $BUILD_BACKUP"
fi
mv "$FRONTEND_TMP_BUILD_DIR" "$FRONTEND_BUILD_DIR"

echo "== Install backend dependencies =="
cd "$BACKEND_DIR"
npm install --production

echo "== Restart backend =="
if pm2 describe "$PM2_APP_NAME" > /dev/null 2>&1; then
  pm2 reload "$PM2_APP_NAME" --update-env
else
  pm2 start ecosystem.config.cjs --update-env
fi

pm2 save

echo "== Test nginx =="
nginx -t

echo "== Reload nginx =="
systemctl reload nginx

echo "== Health check =="
curl -I http://127.0.0.1:4000 || true
curl -k --resolve junandkang.com:443:127.0.0.1 -I https://junandkang.com/ || true

echo "== Deploy completed successfully =="
