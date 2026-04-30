const db = require('../config/database');
const {
  insertInventoryMovement,
  isDuplicateKeyError,
  normalizeSku,
} = require('./inventoryService');
const { refreshSkuCompositionsFromSheet } = require('./skuCompositionService');

const RECEIPT_SHEET_NAME = process.env.GOOGLE_RECEIPT_SHEET_NAME || '\uC785\uACE0\uAD00\uB9AC';
const RECEIPT_RANGE = `${RECEIPT_SHEET_NAME}!A:N`;
const STATUS_PENDING = '\uB300\uAE30';
const STATUS_SYNCED = '\uB3D9\uAE30\uD654\uC644\uB8CC';
const STATUS_ERROR = '\uC624\uB958';

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

function parseInteger(value) {
  const number = parseNumber(value);
  if (number === null) return null;
  return Math.trunc(number);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatMysqlDateTime(date) {
  if (!date || Number.isNaN(date.getTime())) return null;
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join('-') + ' ' + [
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
  ].join(':');
}

function parseSheetDate(value) {
  if (isBlank(value)) return null;

  if (typeof value === 'number') {
    const epochMs = Date.UTC(1899, 11, 30);
    return new Date(epochMs + value * 24 * 60 * 60 * 1000);
  }

  const raw = String(value).trim();
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 1000) {
    const epochMs = Date.UTC(1899, 11, 30);
    return new Date(epochMs + serial * 24 * 60 * 60 * 1000);
  }

  const normalized = raw.replace(/\./g, '-').replace(/\//g, '-');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
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
  const axios = require('axios');
  const { data } = await axios.get(getSheetsUrl(range), { timeout: 30000 });
  return data.values || [];
}

function isHeaderRow(row, firstHeader) {
  return cleanText(row?.[0]) === firstHeader;
}

function parseReceiptRow(row, index) {
  const sheetRow = index + 1;
  if (isHeaderRow(row, '\uC785\uACE0ID')) return { skip: true, reason: 'header' };

  const status = cleanText(row[13]);
  if (status !== STATUS_PENDING) return { skip: true, reason: `status=${status || '-'}` };

  const receipt = {
    receipt_id: cleanText(row[0]),
    receipt_no: parseInteger(row[1]),
    received_at: formatMysqlDateTime(parseSheetDate(row[2])),
    source_sku: normalizeSku(row[3]),
    quantity: parseInteger(row[7]),
    source_unit_cost: parseNumber(row[10]),
    receipt_type: cleanText(row[11]),
    note: cleanText(row[12]),
    status,
    sheet_row: sheetRow,
  };

  const errors = [];
  if (!receipt.receipt_id) errors.push('missing receipt_id');
  if (!receipt.source_sku) errors.push('missing source_sku');
  if (!receipt.quantity || receipt.quantity <= 0) errors.push('invalid quantity');
  if (receipt.source_unit_cost === null || receipt.source_unit_cost < 0) errors.push('invalid unit_cost');
  if (!receipt.receipt_type) errors.push('missing receipt_type');

  if (errors.length) {
    return { invalid: true, receipt, reason: errors.join(', ') };
  }

  return { receipt };
}

async function loadPendingReceipts() {
  const rows = await fetchSheetValues(RECEIPT_RANGE);
  const receipts = [];
  const invalidRows = [];
  let skipped = 0;

  rows.forEach((row, index) => {
    const parsed = parseReceiptRow(row, index);
    if (parsed.skip) {
      skipped++;
      return;
    }
    if (parsed.invalid) {
      invalidRows.push(parsed);
      return;
    }
    receipts.push(parsed.receipt);
  });

  return { receipts, invalidRows, skipped };
}

function getCompositionRows(compositionMap, sourceSku) {
  const rows = compositionMap.get(sourceSku);
  if (rows && rows.length) return rows;
  return [{ baseSku: sourceSku, factor: 1, type: 'default', note: null, sheet_row: null }];
}

function aggregateCompositions(compositions) {
  const byBaseSku = new Map();

  for (const item of compositions) {
    const existing = byBaseSku.get(item.baseSku);
    if (!existing) {
      byBaseSku.set(item.baseSku, { ...item });
      continue;
    }

    existing.factor += Number(item.factor || 0);
    existing.type = [existing.type, item.type].filter(Boolean).join(',');
    existing.note = [existing.note, item.note].filter(Boolean).join(' / ');
  }

  return Array.from(byBaseSku.values());
}

function ensureIntegerQuantity(value, context) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${context} invalid base stock quantity: ${value}`);
  }
  return value;
}

async function getExistingProducts(conn, skus) {
  if (!skus.length) return new Set();
  const placeholders = skus.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT sku FROM products WHERE sku IN (${placeholders})`,
    skus
  );
  return new Set(rows.map(row => row.sku));
}

async function insertInventoryBatch(conn, receipt, composition, baseQty, baseUnitCost, totalFactor) {
  const [result] = await conn.query(
    `INSERT INTO inventory_batches
       (receipt_id, receipt_no, source_sku, sku, received_at, receipt_type,
        initial_qty, remaining_qty, unit_cost, source_unit_cost,
        conversion_factor, note, sheet_row)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      receipt.receipt_id,
      receipt.receipt_no,
      receipt.source_sku,
      composition.baseSku,
      receipt.received_at,
      receipt.receipt_type,
      baseQty,
      baseQty,
      baseUnitCost,
      receipt.source_unit_cost,
      composition.factor,
      receipt.note || composition.note || `source=${receipt.source_sku}; total_factor=${totalFactor}`,
      receipt.sheet_row,
    ]
  );
  return result.affectedRows === 1;
}

function buildStockInNote(receipt, composition, baseQty, baseUnitCost) {
  return [
    `receipt_id=${receipt.receipt_id}`,
    `source_sku=${receipt.source_sku}`,
    `source_qty=${receipt.quantity}`,
    `source_unit_cost=${receipt.source_unit_cost}`,
    `base_qty=${baseQty}`,
    `base_unit_cost=${baseUnitCost.toFixed(2)}`,
    `factor=${composition.factor}`,
  ].join('; ');
}

async function processReceipt(receipt, compositionMap) {
  const rawCompositions = getCompositionRows(compositionMap, receipt.source_sku);
  const totalFactor = rawCompositions.reduce((sum, item) => sum + Number(item.factor || 0), 0);
  const compositions = aggregateCompositions(rawCompositions);
  const baseSkus = Array.from(new Set(compositions.map(item => item.baseSku)));

  if (!totalFactor || totalFactor <= 0) {
    throw new Error(`invalid composition factor total: receipt_id=${receipt.receipt_id}`);
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const existingProducts = await getExistingProducts(conn, baseSkus);
    const missingSkus = baseSkus.filter(sku => !existingProducts.has(sku));
    if (missingSkus.length) {
      throw new Error(`missing products for base SKU: ${missingSkus.join(', ')}`);
    }

    let insertedBatches = 0;
    let stockAdded = 0;
    let duplicateBatches = 0;
    const baseUnitCost = receipt.source_unit_cost / totalFactor;

    for (const composition of compositions) {
      const baseQty = ensureIntegerQuantity(
        receipt.quantity * Number(composition.factor),
        `receipt_id=${receipt.receipt_id}, sku=${composition.baseSku}`
      );

      let inserted = false;
      try {
        inserted = await insertInventoryBatch(conn, receipt, composition, baseQty, baseUnitCost, totalFactor);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          duplicateBatches++;
          console.log(`[InventoryReceiptSync] duplicate inventory_batch skipped: receipt_id=${receipt.receipt_id}, sku=${composition.baseSku}`);
          continue;
        }
        throw err;
      }

      if (!inserted) continue;

      await conn.query(
        `UPDATE products
         SET stock_quantity = stock_quantity + ?
         WHERE sku = ?`,
        [baseQty, composition.baseSku]
      );

      await insertInventoryMovement(conn, {
        sku: composition.baseSku,
        movement_type: 'STOCK_IN',
        qty_delta: baseQty,
        note: buildStockInNote(receipt, composition, baseQty, baseUnitCost),
      });

      insertedBatches++;
      stockAdded += baseQty;
      console.log(`[InventoryReceiptSync] STOCK_IN created: receipt_id=${receipt.receipt_id}, source=${receipt.source_sku}, sku=${composition.baseSku}, qty=+${baseQty}`);
    }

    await conn.commit();
    return { insertedBatches, stockAdded, duplicateBatches };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function updateReceiptStatus(sheetRow, status, reason) {
  console.log(`[InventoryReceiptSync] sheet status update skipped: row=${sheetRow}, status=${status}, reason=${reason || 'read-only API key authentication'}`);
  return { updated: false, skipped: true };
}

async function syncPendingInventoryReceipts() {
  const result = {
    processed: 0,
    inserted_batches: 0,
    stock_added: 0,
    skipped: 0,
    errors: 0,
    sheet_status_updated: 0,
    sheet_status_update_failed: 0,
    sheet_status_update_skipped: 0,
    sku_compositions_upserted: 0,
    sku_compositions_skipped: 0,
    sku_compositions_errors: 0,
  };

  const [compositionRefresh, pendingData] = await Promise.all([
    refreshSkuCompositionsFromSheet(),
    loadPendingReceipts(),
  ]);

  const compositionMap = compositionRefresh.compositionMap;
  result.sku_compositions_upserted = compositionRefresh.upserted;
  result.sku_compositions_skipped = compositionRefresh.skipped;
  result.sku_compositions_errors = compositionRefresh.errors;
  result.skipped += pendingData.skipped;

  for (const invalid of pendingData.invalidRows) {
    result.errors++;
    console.error(`[InventoryReceiptSync] receipt row invalid: row=${invalid.receipt?.sheet_row || '-'}, reason=${invalid.reason}`);
    const statusResult = await updateReceiptStatus(invalid.receipt?.sheet_row, STATUS_ERROR, invalid.reason);
    if (statusResult.updated) result.sheet_status_updated++;
    else result.sheet_status_update_skipped++;
  }

  for (const receipt of pendingData.receipts) {
    try {
      const receiptResult = await processReceipt(receipt, compositionMap);
      result.processed++;
      result.inserted_batches += receiptResult.insertedBatches;
      result.stock_added += receiptResult.stockAdded;
      result.skipped += receiptResult.duplicateBatches;

      const statusResult = await updateReceiptStatus(receipt.sheet_row, STATUS_SYNCED);
      if (statusResult.updated) result.sheet_status_updated++;
      else result.sheet_status_update_skipped++;
    } catch (err) {
      result.errors++;
      console.error(`[InventoryReceiptSync] receipt sync error: receipt_id=${receipt.receipt_id || '-'}, source_sku=${receipt.source_sku || '-'}: ${err.message}`);
      const statusResult = await updateReceiptStatus(receipt.sheet_row, STATUS_ERROR, err.message);
      if (statusResult.updated) result.sheet_status_updated++;
      else result.sheet_status_update_skipped++;
    }
  }

  console.log(
    `[InventoryReceiptSync] done: processed=${result.processed}, inserted_batches=${result.inserted_batches}, stock_added=${result.stock_added}, skipped=${result.skipped}, errors=${result.errors}, sku_compositions_upserted=${result.sku_compositions_upserted}, sheet_status_updated=${result.sheet_status_updated}, sheet_status_update_skipped=${result.sheet_status_update_skipped}`
  );

  return result;
}

module.exports = {
  loadPendingReceipts,
  syncPendingInventoryReceipts,
};
