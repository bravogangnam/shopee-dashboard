'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const bwipjs = require('bwip-js');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { CURRENT_TENANT_ID } = require('../config/tenant');

const MM_TO_PT = 72 / 25.4;
const PAGE_W = Math.round(105 * MM_TO_PT);
const PAGE_H = Math.round(148 * MM_TO_PT);
const TMP_DIR = path.resolve(__dirname, '../../../data/tmp/packing-labels');
const CJK_FONT_CANDIDATES = [
  process.env.INVOICE_KR_FONT_PATH,
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
  '/usr/share/fonts/truetype/nanum/NanumBarunGothic.ttf',
  '/usr/share/fonts/truetype/nanum/NanumSquareR.ttf',
  path.resolve(__dirname, '../../assets/fonts/NotoSansKR-Regular.otf'),
  path.resolve(__dirname, '../../assets/fonts/NotoSansCJKkr-Regular.otf'),
].filter(Boolean);
const CJK_REGEX = /[\u1100-\u11FF\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFFEF]/;
const CJK_GLOBAL_REGEX = /[\u1100-\u11FF\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFFEF]/g;

function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function cleanupOldTmpFiles(maxAgeMs = 60 * 60 * 1000) {
  ensureTmpDir();
  const now = Date.now();
  for (const entry of fs.readdirSync(TMP_DIR)) {
    if (!entry.endsWith('.pdf')) continue;
    const filePath = path.join(TMP_DIR, entry);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

function formatTimestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function loadFonts(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const latin = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const latinBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let cjk = null;
  for (const fontPath of CJK_FONT_CANDIDATES) {
    try {
      if (!fs.existsSync(fontPath)) continue;
      cjk = await pdfDoc.embedFont(fs.readFileSync(fontPath), { subset: false });
      break;
    } catch (_) {}
  }
  return {
    latin,
    latinBold,
    cjk,
    pick(text, bold = false) {
      if (cjk && CJK_REGEX.test(String(text || ''))) return cjk;
      return bold ? latinBold : latin;
    },
    safe(text) {
      const value = String(text ?? '');
      return cjk ? value : value.replace(CJK_GLOBAL_REGEX, '?');
    },
  };
}

function truncateByWidth(text, maxWidth, font, size) {
  let value = cleanText(text);
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  while (value.length > 1 && font.widthOfTextAtSize(`${value}…`, size) > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

async function createCode128Png(text) {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text,
    scale: 4,
    height: 28,
    includetext: false,
    paddingwidth: 14,
    paddingheight: 2,
    backgroundcolor: 'FFFFFF',
  });
}

async function createQrPng(text) {
  return bwipjs.toBuffer({ bcid: 'qrcode', text, scale: 5, eclevel: 'M', paddingwidth: 2, paddingheight: 2, backgroundcolor: 'FFFFFF' });
}

async function fetchPackingLabelOrders(orderSnList, { tenantId = CURRENT_TENANT_ID } = {}) {
  const orderSns = [...new Set((orderSnList || []).map(cleanText).filter(Boolean))];
  if (!orderSns.length) throw new Error('order_sns required');
  const placeholders = orderSns.map(() => '?').join(',');
  const [ordersRaw] = await db.query(
    `SELECT o.tenant_id, o.shop_id, o.region, o.order_sn, o.order_status, o.tracking_number,
            s.shop_name, s.alias AS shop_alias, COALESCE(s.region, o.region) AS shop_region
       FROM orders o
       LEFT JOIN shops s ON s.tenant_id = o.tenant_id AND s.shop_id = o.shop_id
      WHERE o.tenant_id = ? AND o.order_sn IN (${placeholders})`,
    [tenantId, ...orderSns]
  );
  const orders = orderSns.map(orderSn => ordersRaw.find(row => row.order_sn === orderSn)).filter(Boolean);
  if (orders.length !== orderSns.length) throw new Error('some orders were not found for current tenant');
  const [items] = await db.query(
    `SELECT oi.order_sn,
            COALESCE(NULLIF(p.product_name_kr, ''), oi.item_name) AS item_name,
            CASE WHEN p.product_name_kr IS NOT NULL AND p.product_name_kr != '' THEN '' ELSE oi.model_name END AS model_name,
            COALESCE(NULLIF(oi.model_sku, ''), NULLIF(oi.item_sku, '')) AS sku,
            oi.model_quantity_purchased AS quantity
       FROM order_items oi
       LEFT JOIN products p
         ON p.tenant_id = oi.tenant_id
        AND p.sku COLLATE utf8mb4_general_ci = COALESCE(NULLIF(oi.model_sku, ''), NULLIF(oi.item_sku, '')) COLLATE utf8mb4_general_ci
      WHERE oi.tenant_id = ? AND oi.order_sn IN (${placeholders})
      ORDER BY oi.order_sn, oi.id`,
    [tenantId, ...orderSns]
  );
  const itemsByOrder = new Map();
  for (const item of items) {
    if (!itemsByOrder.has(item.order_sn)) itemsByOrder.set(item.order_sn, []);
    itemsByOrder.get(item.order_sn).push(item);
  }
  return orders.map(order => ({ ...order, items: itemsByOrder.get(order.order_sn) || [] }));
}

async function drawPackingLabelPage(pdfDoc, fonts, order) {
  const trackingNumber = cleanText(order.tracking_number);
  if (!trackingNumber) throw new Error(`tracking_number missing: ${order.order_sn}`);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.35, 0.35, 0.35);
  const pad = 14;
  let y = PAGE_H - 18;

  const region = cleanText(order.shop_region || order.region || '-');
  const shopName = cleanText(order.shop_alias || order.shop_name || order.shop_id);
  const header = `Shopee [${region}] ${shopName} ${formatTimestamp()}`;
  const safeHeader = fonts.safe(header);
  page.drawText(truncateByWidth(safeHeader, PAGE_W - pad * 2, fonts.pick(header), 9), { x: pad, y, size: 9, font: fonts.pick(header), color: black });
  y -= 12;
  page.drawText('TEST PACKING LABEL - NOT VERIFIED', { x: pad, y, size: 6, font: fonts.latinBold, color: gray });
  y -= 82;

  const barcodePng = await createCode128Png(trackingNumber);
  const barcode = await pdfDoc.embedPng(barcodePng);
  const barcodeW = PAGE_W * 0.82;
  const barcodeH = 30 * MM_TO_PT;
  page.drawImage(barcode, { x: (PAGE_W - barcodeW) / 2, y, width: barcodeW, height: barcodeH });
  y -= 13;
  const tnW = fonts.latinBold.widthOfTextAtSize(trackingNumber, 13);
  page.drawText(trackingNumber, { x: Math.max(pad, (PAGE_W - tnW) / 2), y, size: 13, font: fonts.latinBold, color: black });
  y -= 22;

  page.drawLine({ start: { x: pad, y }, end: { x: PAGE_W - pad, y }, thickness: 0.6, color: black });
  y -= 12;
  page.drawText('#', { x: pad, y, size: 8, font: fonts.latinBold, color: black });
  page.drawText(fonts.safe('상품명 / 옵션'), { x: pad + 18, y, size: 8, font: fonts.pick('상품명 / 옵션', true), color: black });
  page.drawText(fonts.safe('수량'), { x: PAGE_W - pad - 24, y, size: 8, font: fonts.pick('수량', true), color: black });
  y -= 8;
  page.drawLine({ start: { x: pad, y }, end: { x: PAGE_W - pad, y }, thickness: 0.4, color: gray });
  y -= 11;

  const items = order.items.length ? order.items : [{ item_name: '-', model_name: '', sku: '', quantity: 1 }];
  let totalQty = 0;
  items.forEach((item, index) => {
    const qty = Number(item.quantity || 0) || 0;
    totalQty += qty;
    if (y < 78) return;
    const name = cleanText(item.item_name) || '-';
    const option = cleanText(item.model_name);
    const sku = cleanText(item.sku);
    page.drawText(String(index + 1), { x: pad, y, size: 8, font: fonts.latin, color: black });
    page.drawText(truncateByWidth(fonts.safe(name), PAGE_W - pad * 2 - 62, fonts.pick(name), 8.5), { x: pad + 18, y, size: 8.5, font: fonts.pick(name), color: black });
    page.drawText(String(qty || '-'), { x: PAGE_W - pad - 18, y, size: 8.5, font: fonts.latinBold, color: black });
    y -= 10;
    if (option) {
      page.drawText(truncateByWidth(fonts.safe(`- ${option}`), PAGE_W - pad * 2 - 48, fonts.pick(option), 7.5), { x: pad + 22, y, size: 7.5, font: fonts.pick(option), color: gray });
      y -= 9;
    }
    if (sku) {
      page.drawText(truncateByWidth(`SKU: ${sku}`, PAGE_W - pad * 2 - 48, fonts.latin, 7.5), { x: pad + 22, y, size: 7.5, font: fonts.latin, color: gray });
      y -= 10;
    }
    page.drawLine({ start: { x: pad, y: y + 3 }, end: { x: PAGE_W - pad, y: y + 3 }, thickness: 0.2, color: rgb(0.82, 0.82, 0.82) });
  });

  const qrPng = await createQrPng(order.order_sn);
  const qr = await pdfDoc.embedPng(qrPng);
  page.drawImage(qr, { x: pad, y: 18, width: 46, height: 46 });
  page.drawText('Order ID', { x: pad + 54, y: 52, size: 8, font: fonts.latinBold, color: black });
  page.drawText(cleanText(order.order_sn), { x: pad + 54, y: 40, size: 8.5, font: fonts.latinBold, color: black });
  page.drawText(fonts.safe(`총 수량: ${totalQty}`), { x: PAGE_W - pad - 70, y: 25, size: 10, font: fonts.pick('총 수량', true), color: black });
}

async function buildPackingLabelsPdfFromOrders(orders, { writeTmp = false } = {}) {
  cleanupOldTmpFiles();
  const missingTracking = orders.find(order => !cleanText(order.tracking_number));
  if (missingTracking) {
    const err = new Error(`tracking_number missing: ${missingTracking.order_sn}`);
    err.code = 'TRACKING_NUMBER_MISSING';
    throw err;
  }
  const pdfDoc = await PDFDocument.create();
  const fonts = await loadFonts(pdfDoc);
  for (const order of orders) await drawPackingLabelPage(pdfDoc, fonts, order);
  const bytes = await pdfDoc.save();
  const buffer = Buffer.from(bytes);
  let tmpPath = null;
  if (writeTmp) {
    ensureTmpDir();
    tmpPath = path.join(TMP_DIR, `packing-label-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`);
    fs.writeFileSync(tmpPath, buffer);
    setTimeout(() => fs.promises.unlink(tmpPath).catch(() => {}), 10 * 60 * 1000).unref?.();
  }
  return { buffer, tmpPath, count: orders.length };
}

async function buildPackingLabelsPdf(orderSnList, { tenantId = CURRENT_TENANT_ID, writeTmp = false } = {}) {
  const orders = await fetchPackingLabelOrders(orderSnList, { tenantId });
  return buildPackingLabelsPdfFromOrders(orders, { writeTmp });
}

module.exports = {
  TMP_DIR,
  buildPackingLabelsPdf,
  buildPackingLabelsPdfFromOrders,
  fetchPackingLabelOrders,
};
