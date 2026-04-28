const axios = require('axios');
const cron = require('node-cron');
const db = require('../config/database');

const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || '차트';
const SHEET_RANGE = `${SHEET_NAME}!A:L`;
const COST_FIELDS = ['cost_price', 'discounted_price_with_vat', 'supply_rate'];

let isRunning = false;
let lastRunAt = null;
let lastResult = null;

function isBlank(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return text === '' || text.toLowerCase() === 'nan';
}

function cleanText(value) {
  return isBlank(value) ? null : String(value).trim();
}

function parseNumber(value) {
  if (isBlank(value)) return null;
  const number = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : null;
}

function parsePercent(value) {
  if (isBlank(value)) return null;
  const raw = String(value).replace(/,/g, '').trim();
  const hasPercent = raw.includes('%');
  const number = parseFloat(raw.replace(/%/g, ''));
  if (!Number.isFinite(number)) return null;
  return hasPercent ? number / 100 : number;
}

function normalizeDbNumber(value) {
  if (value === undefined || value === null) return null;
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function numbersEqual(left, right) {
  const a = normalizeDbNumber(left);
  const b = normalizeDbNumber(right);
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.0001;
}

function productChanged(existing, product) {
  return [
    'brand',
    'product_name_en',
    'option_name',
    'product_name_kr',
    'weight',
    'cost_price_with_vat',
    'supply_rate',
    'discounted_price_with_vat',
    'cost_price',
    'vat',
  ].some(field => {
    if (typeof product[field] === 'number' || typeof existing[field] === 'number') {
      return !numbersEqual(existing[field], product[field]);
    }
    return (existing[field] ?? null) !== (product[field] ?? null);
  });
}

function costChanged(existing, product) {
  return COST_FIELDS.some(field => !numbersEqual(existing[field], product[field]));
}

function parseSheetRow(row, rowIndex) {
  const sku = cleanText(row[0]);
  if (!sku) return { skip: true, reason: 'empty sku' };

  return {
    sku,
    brand: cleanText(row[1]),
    product_name_en: cleanText(row[2]),
    option_name: cleanText(row[3]),
    product_name_kr: cleanText(row[5]),
    weight: parseNumber(row[6]),
    cost_price_with_vat: parseNumber(row[7]),
    supply_rate: parsePercent(row[8]),
    discounted_price_with_vat: parseNumber(row[9]),
    cost_price: parseNumber(row[10]),
    vat: parseNumber(row[11]),
    _rowNumber: rowIndex + 1,
  };
}

function getSheetsUrl() {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!apiKey || !sheetId) {
    throw new Error('GOOGLE_SHEETS_API_KEY and GOOGLE_SHEET_ID are required');
  }

  return `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(SHEET_RANGE)}?key=${encodeURIComponent(apiKey)}`;
}

async function insertCostHistory(conn, product) {
  await conn.query(
    `INSERT INTO product_cost_history
      (sku, cost_price, vat, supply_rate, discounted_price_with_vat, effective_from)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      product.sku,
      product.cost_price,
      product.vat,
      product.supply_rate,
      product.discounted_price_with_vat,
    ]
  );
}

async function insertProduct(conn, product) {
  await conn.query(
    `INSERT INTO products (
      sku, brand, product_name_en, option_name, product_name_kr, weight,
      cost_price_with_vat, supply_rate, discounted_price_with_vat, cost_price, vat
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      product.sku,
      product.brand,
      product.product_name_en,
      product.option_name,
      product.product_name_kr,
      product.weight,
      product.cost_price_with_vat,
      product.supply_rate,
      product.discounted_price_with_vat,
      product.cost_price,
      product.vat,
    ]
  );
}

async function updateProduct(conn, product) {
  await conn.query(
    `UPDATE products SET
      brand = ?,
      product_name_en = ?,
      option_name = ?,
      product_name_kr = ?,
      weight = ?,
      cost_price_with_vat = ?,
      supply_rate = ?,
      discounted_price_with_vat = ?,
      cost_price = ?,
      vat = ?
     WHERE sku = ?`,
    [
      product.brand,
      product.product_name_en,
      product.option_name,
      product.product_name_kr,
      product.weight,
      product.cost_price_with_vat,
      product.supply_rate,
      product.discounted_price_with_vat,
      product.cost_price,
      product.vat,
      product.sku,
    ]
  );
}

async function syncGoogleSheet() {
  const result = { inserted: 0, cost_changed: 0, updated: 0, skipped: 0 };

  try {
    const { data } = await axios.get(getSheetsUrl(), { timeout: 30000 });
    const rows = data.values || [];
    const dataRows = rows.slice(2);

    const conn = await db.getConnection();
    try {
      for (let i = 0; i < dataRows.length; i++) {
        const rowIndex = i + 2;

        try {
          const product = parseSheetRow(dataRows[i], rowIndex);
          if (product.skip) {
            result.skipped++;
            continue;
          }

          const [existingRows] = await conn.query(
            'SELECT * FROM products WHERE sku = ? LIMIT 1',
            [product.sku]
          );

          if (!existingRows.length) {
            await conn.beginTransaction();
            try {
              await insertProduct(conn, product);
              await insertCostHistory(conn, product);
              await conn.commit();
              result.inserted++;
            } catch (err) {
              await conn.rollback();
              throw err;
            }
            continue;
          }

          const existing = existingRows[0];
          if (!productChanged(existing, product)) {
            result.skipped++;
            continue;
          }

          if (costChanged(existing, product)) {
            await conn.beginTransaction();
            try {
              await updateProduct(conn, product);
              await conn.query(
                'UPDATE product_cost_history SET effective_to = NOW() WHERE sku = ? AND effective_to IS NULL',
                [product.sku]
              );
              await insertCostHistory(conn, product);
              await conn.commit();
              result.cost_changed++;
            } catch (err) {
              await conn.rollback();
              throw err;
            }
          } else {
            await updateProduct(conn, product);
            result.updated++;
          }
        } catch (err) {
          result.skipped++;
          console.error(`[GoogleSheetSync] row ${rowIndex + 1} skipped: ${err.message}`);
        }
      }
    } finally {
      conn.release();
    }

    console.log(`[GoogleSheetSync] 완료: 신규 ${result.inserted}건, 원가변경 ${result.cost_changed}건, 기타업데이트 ${result.updated}건, 스킵 ${result.skipped}건`);
    lastResult = { success: true, ...result };
    return result;
  } catch (err) {
    lastResult = { success: false, error: err.message };
    console.error(`[GoogleSheetSync] 오류: ${err.message}`);
    return { ...result, error: err.message };
  }
}

async function runGoogleSheetSync() {
  if (isRunning) {
    console.log('[GoogleSheetSync] 이전 동기화 진행 중 - 스킵');
    return lastResult;
  }

  isRunning = true;
  lastRunAt = new Date();
  try {
    return await syncGoogleSheet();
  } finally {
    isRunning = false;
  }
}

function startGoogleSheetSyncJob() {
  setTimeout(() => {
    runGoogleSheetSync().catch(err => {
      console.error(`[GoogleSheetSync] initial run error: ${err.message}`);
    });
  }, 90 * 1000);

  cron.schedule('*/5 * * * *', () => {
    runGoogleSheetSync().catch(err => {
      console.error(`[GoogleSheetSync] cron error: ${err.message}`);
    });
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  console.log('[GoogleSheetSync] scheduled (every 5 minutes)');
}

function getGoogleSheetSyncStatus() {
  return { isRunning, lastRunAt, lastResult };
}

module.exports = {
  syncGoogleSheet,
  startGoogleSheetSyncJob,
  getGoogleSheetSyncStatus,
};
