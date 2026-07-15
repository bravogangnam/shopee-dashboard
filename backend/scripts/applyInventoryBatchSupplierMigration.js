require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const db = require('../src/config/database');

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function main() {
  const hasSupplier = await columnExists('inventory_batches', 'supplier');
  if (hasSupplier) {
    console.log('[InventoryBatchSupplierMigration] inventory_batches.supplier already exists; skipping.');
    return;
  }

  await db.query(
    `ALTER TABLE inventory_batches
       ADD COLUMN supplier VARCHAR(255) NULL AFTER source_unit_cost`
  );
  console.log('[InventoryBatchSupplierMigration] Added inventory_batches.supplier.');
}

main()
  .catch(err => {
    console.error('[InventoryBatchSupplierMigration] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
