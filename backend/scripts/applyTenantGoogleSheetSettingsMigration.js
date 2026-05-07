require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../src/config/database');

async function main() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_google_sheet_settings (
      tenant_id INT NOT NULL PRIMARY KEY,
      google_sheet_id VARCHAR(255) NULL,
      last_chart_synced_at DATETIME NULL,
      last_receipt_synced_at DATETIME NULL,
      last_composition_synced_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant_google_sheet_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('tenant_google_sheet_settings migration applied');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('tenant_google_sheet_settings migration failed:', err);
    process.exit(1);
  });
