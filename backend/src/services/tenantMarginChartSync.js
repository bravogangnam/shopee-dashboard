const axios = require('axios');
const db = require('../config/database');

const CHART_SHEET_NAME = '차트';
const CHART_RANGE = `${CHART_SHEET_NAME}!A:AE`;
const VALID_PRODUCT_SKU_PATTERN = /^GS_?\d{5}$/i;

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

function normalizeSku(value) {
  const sku = cleanText(value);
  return sku ? sku.toUpperCase().replace(/^GS(\\d{5})$/, 'GS_$1') : null;
}

function isValidProductSku(sku) {
  return VALID_PRODUCT_SKU_PATTERN.test(String(sku || '').trim());
}

async function getTenantGoogleSheetId(tenantId) {
  const [rows] = await db.query(
    'SELECT google_sheet_id FROM tenant_google_sheet_settings WHERE tenant_id = ? LIMIT 1',
    [tenantId]
  );

  const sheetId = rows[0]?.google_sheet_id ? String(rows[0].google_sheet_id).trim() : '';
  if (!sheetId) {
    throw new Error('Google Sheet ID is not configured');
  }

  return sheetId;
}

function getSheetsUrl(sheetId) {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_SHEETS_API_KEY is required');
  }

  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(CHART_RANGE)}?key=${encodeURIComponent(apiKey)}`;
}

async function fetchChartRows(tenantId) {
  const sheetId = await getTenantGoogleSheetId(tenantId);
  const { data } = await axios.get(getSheetsUrl(sheetId), { timeout: 30000 });
  return {
    sheetId,
    rows: data.values || [],
  };
}

function parseChartRow(row, rowIndex) {
  const sku = normalizeSku(row[0]);

  if (!sku) {
    return { skip: true, reason: 'empty sku', rowNumber: rowIndex + 1 };
  }

  if (!isValidProductSku(sku)) {
    return { skip: true, reason: `invalid sku: ${sku}`, rowNumber: rowIndex + 1 };
  }

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
    price_sg: parseNumber(row[12]),
    price_tw: parseNumber(row[16]),
    price_my: parseNumber(row[19]),
    price_ph: parseNumber(row[23]),
    price_th: parseNumber(row[26]),
    price_vn: parseNumber(row[30]),
    source_row: rowIndex + 1,
  };
}

function parseChartRows(rows) {
  const dataRows = rows.slice(2);
  const items = [];
  const errors = [];
  let skipped = 0;

  for (let i = 0; i < dataRows.length; i += 1) {
    const rowIndex = i + 2;
    const parsed = parseChartRow(dataRows[i], rowIndex);

    if (parsed.skip) {
      skipped += 1;
      if (parsed.reason !== 'empty sku' && errors.length < 20) {
        errors.push({
          row: parsed.rowNumber,
          reason: parsed.reason,
        });
      }
      continue;
    }

    items.push(parsed);
  }

  return {
    items,
    skipped,
    errors,
  };
}

async function testMarginChartSheet({ tenantId }) {
  const { sheetId, rows } = await fetchChartRows(tenantId);
  const parsed = parseChartRows(rows);

  return {
    sheet_id: sheetId,
    sheet_name: CHART_SHEET_NAME,
    total_rows: Math.max(rows.length - 2, 0),
    parsed_count: parsed.items.length,
    skipped_count: parsed.skipped,
    errors: parsed.errors,
    sample: parsed.items.slice(0, 5),
  };
}

async function syncMarginChartSheet({ tenantId }) {
  const { sheetId, rows } = await fetchChartRows(tenantId);
  const parsed = parseChartRows(rows);

  const result = {
    sheet_id: sheetId,
    sheet_name: CHART_SHEET_NAME,
    total_rows: Math.max(rows.length - 2, 0),
    upserted: 0,
    deactivated: 0,
    skipped_count: parsed.skipped,
    errors: parsed.errors,
  };

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    await conn.query(
      'UPDATE margin_chart_items SET is_active = 0, updated_at = NOW() WHERE tenant_id = ?',
      [tenantId]
    );

    for (const item of parsed.items) {
      await conn.query(
        `INSERT INTO margin_chart_items (
           tenant_id, sku, brand, product_name_en, option_name, product_name_kr, weight,
           cost_price_with_vat, supply_rate, discounted_price_with_vat, cost_price, vat,
           price_sg, price_tw, price_my, price_ph, price_th, price_vn,
           source_row, is_active, synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           brand = VALUES(brand),
           product_name_en = VALUES(product_name_en),
           option_name = VALUES(option_name),
           product_name_kr = VALUES(product_name_kr),
           weight = VALUES(weight),
           cost_price_with_vat = VALUES(cost_price_with_vat),
           supply_rate = VALUES(supply_rate),
           discounted_price_with_vat = VALUES(discounted_price_with_vat),
           cost_price = VALUES(cost_price),
           vat = VALUES(vat),
           price_sg = VALUES(price_sg),
           price_tw = VALUES(price_tw),
           price_my = VALUES(price_my),
           price_ph = VALUES(price_ph),
           price_th = VALUES(price_th),
           price_vn = VALUES(price_vn),
           source_row = VALUES(source_row),
           is_active = 1,
           synced_at = NOW(),
           updated_at = NOW()`,
        [
          tenantId,
          item.sku,
          item.brand,
          item.product_name_en,
          item.option_name,
          item.product_name_kr,
          item.weight,
          item.cost_price_with_vat,
          item.supply_rate,
          item.discounted_price_with_vat,
          item.cost_price,
          item.vat,
          item.price_sg,
          item.price_tw,
          item.price_my,
          item.price_ph,
          item.price_th,
          item.price_vn,
          item.source_row,
        ]
      );
      result.upserted += 1;
    }

    const [deactivatedRows] = await conn.query(
      'SELECT COUNT(*) AS count FROM margin_chart_items WHERE tenant_id = ? AND is_active = 0',
      [tenantId]
    );
    result.deactivated = Number(deactivatedRows[0]?.count || 0);

    await conn.query(
      'UPDATE tenant_google_sheet_settings SET last_chart_synced_at = NOW(), updated_at = NOW() WHERE tenant_id = ?',
      [tenantId]
    );

    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  testMarginChartSheet,
  syncMarginChartSheet,
};
