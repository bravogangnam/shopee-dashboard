const db = require('../src/config/database');

const migrations = [
  {
    column: 'shop_name',
    sql: 'ALTER TABLE shops ADD COLUMN shop_name VARCHAR(255) NULL AFTER shop_id',
  },
  {
    column: 'shop_logo_url',
    sql: 'ALTER TABLE shops ADD COLUMN shop_logo_url VARCHAR(1000) NULL AFTER shop_name',
  },
  {
    column: 'shop_info_synced_at',
    sql: 'ALTER TABLE shops ADD COLUMN shop_info_synced_at DATETIME NULL AFTER shop_logo_url',
  },
];

async function columnExists(column) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = ?
     LIMIT 1`,
    [column]
  );
  return rows.length > 0;
}

async function run() {
  for (const migration of migrations) {
    if (await columnExists(migration.column)) {
      console.log(`shops.${migration.column} already exists; skipping`);
      continue;
    }
    await db.query(migration.sql);
    console.log(`added shops.${migration.column}`);
  }
  await db.end();
}

run().catch(async err => {
  console.error('shop profile fields migration failed:', err.message);
  await db.end();
  process.exit(1);
});
