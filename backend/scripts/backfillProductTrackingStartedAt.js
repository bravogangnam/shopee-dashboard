#!/usr/bin/env node

/**
 * Backfill products.stock_tracking_started_at for SKUs that are still NULL.
 *
 * Default mode is dry-run. Use --apply to set NULL values to UTC_TIMESTAMP().
 */

require('dotenv').config();

const db = require('../src/config/database');

function parseArgs(argv) {
  const args = {
    apply: false,
    sku: null,
    limit: 100,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--dry-run') {
      args.apply = false;
    } else if (arg === '--sku') {
      args.sku = argv[index + 1] || null;
      index += 1;
    } else if (arg.startsWith('--sku=')) {
      args.sku = arg.slice('--sku='.length) || null;
    } else if (arg === '--limit') {
      args.limit = Number(argv[index + 1] || args.limit);
      index += 1;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length) || args.limit);
    }
  }

  if (!Number.isInteger(args.limit) || args.limit <= 0) args.limit = 100;
  return args;
}

async function findNullTrackingProducts({ sku, limit }) {
  const params = [];
  let where = 'stock_tracking_started_at IS NULL';

  if (sku) {
    where += ' AND sku = ?';
    params.push(sku);
  }

  params.push(limit);
  const [rows] = await db.query(
    `SELECT sku, product_name_kr, product_name_en, stock_tracking_started_at
     FROM products
     WHERE ${where}
     ORDER BY sku ASC
     LIMIT ?`,
    params
  );

  return rows;
}

async function applyBackfill({ sku }) {
  const params = [];
  let where = 'stock_tracking_started_at IS NULL';

  if (sku) {
    where += ' AND sku = ?';
    params.push(sku);
  }

  const [result] = await db.query(
    `UPDATE products
     SET stock_tracking_started_at = UTC_TIMESTAMP()
     WHERE ${where}`,
    params
  );

  return result.affectedRows || 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = await findNullTrackingProducts(args);

  if (!args.apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      count_in_preview: rows.length,
      limit: args.limit,
      sku: args.sku,
      would_update: rows.map(row => ({
        sku: row.sku,
        product_name_kr: row.product_name_kr,
        product_name_en: row.product_name_en,
        stock_tracking_started_at: row.stock_tracking_started_at,
      })),
    }, null, 2));
    return;
  }

  const updated = await applyBackfill(args);
  console.log(JSON.stringify({
    mode: 'apply',
    sku: args.sku,
    updated,
  }, null, 2));
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
