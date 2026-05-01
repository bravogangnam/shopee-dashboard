#!/usr/bin/env node

/**
 * Reconcile products.stock_quantity from FIFO batch remaining qty and open SALE shortages.
 *
 * target_stock_quantity = SUM(inventory_batches.remaining_qty) - open_shortage_qty
 *
 * Default mode is dry-run. Use --apply to update products.stock_quantity.
 */

require('dotenv').config();

const db = require('../src/config/database');

function parseArgs(argv) {
  const args = {
    apply: false,
    sku: null,
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
    }
  }

  return args;
}

async function listSkus(sku) {
  if (sku) return [sku];
  const [rows] = await db.query('SELECT sku FROM products ORDER BY sku ASC');
  return rows.map(row => row.sku).filter(Boolean);
}

async function getBatchRemainingQty(conn, sku) {
  const [rows] = await conn.query(
    `SELECT COALESCE(SUM(remaining_qty), 0) AS batch_remaining_qty
     FROM inventory_batches
     WHERE sku = ?`,
    [sku]
  );
  return Number(rows[0]?.batch_remaining_qty || 0);
}

async function getOpenShortageQty(conn, sku) {
  const [rows] = await conn.query(
    `SELECT COALESCE(SUM(shortage_qty), 0) AS open_shortage_qty
     FROM (
       SELECT
         m.id,
         ABS(m.qty_delta) - COALESCE(SUM(a.qty), 0) AS shortage_qty
       FROM inventory_movements m
       LEFT JOIN inventory_allocations a ON a.movement_id = m.id
       WHERE m.movement_type = 'SALE'
         AND m.sku = ?
       GROUP BY m.id, m.qty_delta
       HAVING shortage_qty > 0
     ) shortage_rows`,
    [sku]
  );
  return Number(rows[0]?.open_shortage_qty || 0);
}

async function getCurrentStockQuantity(conn, sku, { forUpdate = false } = {}) {
  const [rows] = await conn.query(
    `SELECT stock_quantity FROM products WHERE sku = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [sku]
  );
  return rows.length ? Number(rows[0].stock_quantity || 0) : null;
}

async function buildSkuPlan(conn, sku, options = {}) {
  const currentStockQuantity = await getCurrentStockQuantity(conn, sku, options);
  if (currentStockQuantity === null) return null;

  const batchRemainingQty = await getBatchRemainingQty(conn, sku);
  const openShortageQty = await getOpenShortageQty(conn, sku);
  const targetStockQuantity = batchRemainingQty - openShortageQty;

  return {
    sku,
    current_stock_quantity: currentStockQuantity,
    batch_remaining_qty: batchRemainingQty,
    open_shortage_qty: openShortageQty,
    target_stock_quantity: targetStockQuantity,
    will_update: currentStockQuantity !== targetStockQuantity,
  };
}

async function applySkuPlan(sku, plan) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const lockedPlan = await buildSkuPlan(conn, sku, { forUpdate: true });
    if (!lockedPlan) {
      await conn.rollback();
      return null;
    }

    if (lockedPlan.current_stock_quantity !== lockedPlan.target_stock_quantity) {
      await conn.query(
        'UPDATE products SET stock_quantity = ? WHERE sku = ?',
        [lockedPlan.target_stock_quantity, sku]
      );
    }

    await conn.commit();
    return {
      ...lockedPlan,
      before: lockedPlan.current_stock_quantity,
      after: lockedPlan.target_stock_quantity,
      applied: lockedPlan.current_stock_quantity !== lockedPlan.target_stock_quantity,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const skus = await listSkus(args.sku);
  const output = [];

  for (const sku of skus) {
    if (args.apply) {
      const applied = await applySkuPlan(sku);
      if (applied) output.push(applied);
    } else {
      const plan = await buildSkuPlan(db, sku);
      if (plan && (args.sku || plan.will_update)) output.push(plan);
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
