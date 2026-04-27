#!/bin/bash
set -e

APP_DIR="/var/www/shopee-dashboard"
BACKEND_DIR="$APP_DIR/backend"
FRONTEND_BUILD_DIR="$APP_DIR/frontend/build"
PM2_APP_NAME="shopee-dashboard-backend"

echo "== Deploy started =="

cd "$APP_DIR"

echo "== Pull latest code =="
git pull origin main

echo "== Check frontend build =="
if [ ! -d "$FRONTEND_BUILD_DIR" ]; then
  echo "ERROR: frontend build directory not found: $FRONTEND_BUILD_DIR"
  exit 1
fi

echo "== Install backend dependencies =="
cd "$BACKEND_DIR"
npm install --production

echo "== Restart backend =="
pm2 describe "$PM2_APP_NAME" > /dev/null 2>&1 \
  && pm2 reload "$PM2_APP_NAME" \
  || pm2 start ecosystem.config.cjs

pm2 save

echo "== Test nginx =="
nginx -t

echo "== Reload nginx =="
systemctl reload nginx

echo "== Health check =="
curl -I http://127.0.0.1:4000 || true
curl -I http://junandkang.com || true

echo "== Deploy completed successfully =="
