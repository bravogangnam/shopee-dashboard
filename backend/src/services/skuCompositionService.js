const axios = require('axios');
const db = require('../config/database');
const { normalizeSku } = require('./inventoryService');
const { CURRENT_TENANT_ID } = require('../config/tenant');

const COMPOSITION_SHEET_NAME = process.env.GOOGLE_SKU_COMPOSITION_SHEET_NAME || '\uC0C1\uD488\uAD6C\uC131\uD45C';
const COMPOSITION_RANGE = `${COMPOSITION_SHEET_NAME}!A:E`;

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

function getSheetsUrl(range) {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!apiKey || !sheetId) {
    throw new Error('GOOGLE_SHEETS_API_KEY and GOOGLE_SHEET_ID are required');
  }

  return `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?key=${encodeURIComponent(apiKey)}`;
}

async function fetchSheetValues(range) {
  const { data } = await axios.get(getSheetsUrl(range), { timeout: 30000 });
  return data.values || [];
}

function parseCompositionRow(row, index) {
  const sheetRow = index + 1;
  if (cleanText(row?.[0]) === 'SKU') return { skip: true, reason: 'header' };

  const sourceSku = normalizeSku(row[0]);
  const baseSku = normalizeSku(row[1]);
  const factor = parseNumber(row[2]);

  if (!sourceSku) return { skip: true, reason: 'empty source_sku' };
  if (!baseSku) return { skip: true, reason: `empty base_sku for ${sourceSku}` };
  if (!factor || factor <= 0) return { skip: true, reason: `invalid factor for ${sourceSku}` };

  return {
    component: {
      sourceSku,
      baseSku,
      factor,
      type: cleanText(row[3]) || null,
      note: cleanText(row[4]) || null,
      sheet_row: sheetRow,
    },
  };
}

async function loadSkuCompositionRowsFromSheet() {
  const rows = await fetchSheetValues(COMPOSITION_RANGE);
  const components = [];
  const skippedRows = [];

  rows.forEach((row, index) => {
    const parsed = parseCompositionRow(row, index);
    if (parsed.skip) {
      skippedRows.push({ row: index + 1, reason: parsed.reason });
      return;
    }
    components.push(parsed.component);
  });

  return { components, skippedRows };
}

function compositionRowsToMap(components) {
  const compositionMap = new Map();

  for (const component of components) {
    if (!compositionMap.has(component.sourceSku)) {
      compositionMap.set(component.sourceSku, []);
    }
    compositionMap.get(component.sourceSku).push(component);
  }

  return compositionMap;
}

async function upsertSkuComposition(connOrPool, component, { tenantId = CURRENT_TENANT_ID } = {}) {
  await connOrPool.query(
    `INSERT INTO sku_compositions
       (tenant_id, source_sku, base_sku, factor, composition_type, note, sheet_row)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       factor = VALUES(factor),
       composition_type = VALUES(composition_type),
       note = VALUES(note),
       sheet_row = VALUES(sheet_row)`,
    [
      tenantId,
      component.sourceSku,
      component.baseSku,
      component.factor,
      component.type,
      component.note,
      component.sheet_row,
    ]
  );
}

async function refreshSkuCompositionsFromSheet(connOrPool = db, { tenantId = CURRENT_TENANT_ID } = {}) {
  const { components, skippedRows } = await loadSkuCompositionRowsFromSheet();
  const result = {
    upserted: 0,
    skipped: skippedRows.length,
    errors: 0,
    compositionMap: compositionRowsToMap(components),
  };

  for (const skipped of skippedRows) {
    if (skipped.reason !== 'header' && skipped.reason !== 'empty source_sku') {
      console.warn(`[SkuComposition] skipped row=${skipped.row}: ${skipped.reason}`);
    }
  }

  for (const component of components) {
    try {
      await upsertSkuComposition(connOrPool, component, { tenantId });
      result.upserted++;
    } catch (err) {
      result.errors++;
      console.error(`[SkuComposition] upsert error: source=${component.sourceSku}, base=${component.baseSku}: ${err.message}`);
    }
  }

  console.log(`[SkuComposition] refreshed: upserted=${result.upserted}, skipped=${result.skipped}, errors=${result.errors}`);
  return result;
}

async function getSkuComponents(connOrPool, sourceSku, { tenantId = CURRENT_TENANT_ID } = {}) {
  const normalizedSourceSku = normalizeSku(sourceSku);
  if (!normalizedSourceSku) return [];

  const [rows] = await connOrPool.query(
    `SELECT tenant_id, source_sku, base_sku, factor, composition_type, note
     FROM sku_compositions
     WHERE tenant_id = ?
       AND source_sku = ?
     ORDER BY id ASC`,
    [tenantId, normalizedSourceSku]
  );

  if (!rows.length) {
    return [{
      sourceSku: normalizedSourceSku,
      baseSku: normalizedSourceSku,
      factor: 1,
      type: 'default',
      note: '',
    }];
  }

  return rows.map(row => ({
    sourceSku: row.source_sku,
    baseSku: row.base_sku,
    factor: Number(row.factor || 0),
    type: row.composition_type || null,
    note: row.note || null,
  }));
}

module.exports = {
  loadSkuCompositionRowsFromSheet,
  compositionRowsToMap,
  refreshSkuCompositionsFromSheet,
  getSkuComponents,
};
