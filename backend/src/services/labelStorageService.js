/**
 * LabelStorageService
 * - PDF 파일: /home/user/shopee-dashboard/data/shipping-labels/{shop_id}/{order_sn}.pdf
 * - DB: shipping_labels 테이블 (file_path, file_size_bytes, tracking_number)
 * - S3 마이그레이션을 위해 서비스 레이어로 분리
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../config/database');

const BASE_DIR = path.resolve(__dirname, '../../../data/shipping-labels');

// ─── 헬퍼: 디렉토리 보장 ─────────────────────────────────────────
function ensureDir(shopId) {
  const dir = path.join(BASE_DIR, String(shopId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── 파일 경로 생성 ──────────────────────────────────────────────
function filePath(shopId, orderSn) {
  return path.join(BASE_DIR, String(shopId), `${orderSn}.pdf`);
}

/**
 * PDF 바이너리 저장 + DB upsert
 * @param {number} shopId
 * @param {string} orderSn
 * @param {Buffer} binaryData
 * @param {string|null} trackingNumber
 * @returns {string} 저장된 파일 경로
 */
async function save(shopId, orderSn, binaryData, trackingNumber = null) {
  ensureDir(shopId);
  const fp = filePath(shopId, orderSn);
  fs.writeFileSync(fp, binaryData);

  const fileSize = binaryData.length;

  await db.query(
    `INSERT INTO shipping_labels (order_sn, shop_id, file_path, label_format, file_size_bytes, tracking_number)
     VALUES (?, ?, ?, 'PDF', ?, ?)
     ON DUPLICATE KEY UPDATE
       file_path=VALUES(file_path),
       file_size_bytes=VALUES(file_size_bytes),
       tracking_number=COALESCE(VALUES(tracking_number), tracking_number),
       cached_at=NOW()`,
    [orderSn, shopId, fp, fileSize, trackingNumber]
  );

  console.log(`[LabelStorage] saved: ${fp} (${fileSize} bytes)`);
  return fp;
}

/**
 * PDF 바이너리 로드
 * @param {number} shopId
 * @param {string} orderSn
 * @returns {Buffer|null}
 */
function load(shopId, orderSn) {
  const fp = filePath(shopId, orderSn);
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp);
}

/**
 * 캐시 존재 여부 확인 (파일 + DB 모두)
 * @param {number} shopId
 * @param {string} orderSn
 * @returns {boolean}
 */
function exists(shopId, orderSn) {
  const fp = filePath(shopId, orderSn);
  return fs.existsSync(fp);
}

/**
 * DB에서 레이블 메타데이터 조회
 */
async function getMeta(shopId, orderSn) {
  const [rows] = await db.query(
    'SELECT * FROM shipping_labels WHERE order_sn=? AND shop_id=? LIMIT 1',
    [orderSn, shopId]
  );
  return rows[0] || null;
}

/**
 * DB에서 tracking_number 업데이트
 */
async function updateTracking(shopId, orderSn, trackingNumber) {
  await db.query(
    `UPDATE shipping_labels SET tracking_number=? WHERE order_sn=? AND shop_id=?`,
    [trackingNumber, orderSn, shopId]
  );
  // orders 테이블도 업데이트
  await db.query(
    `UPDATE orders SET tracking_number=? WHERE order_sn=? AND shop_id=?`,
    [trackingNumber, orderSn, shopId]
  );
}

module.exports = { save, load, exists, getMeta, updateTracking, filePath, BASE_DIR };
