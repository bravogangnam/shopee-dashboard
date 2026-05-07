require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../src/config/database');

async function main() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS margin_chart_items (
      tenant_id BIGINT NOT NULL,
      sku VARCHAR(50) NOT NULL,
      brand VARCHAR(200) NULL,
      product_name_en TEXT NULL,
      option_name VARCHAR(200) NULL,
      product_name_kr VARCHAR(200) NULL,
      weight DECIMAL(10,2) NULL,
      cost_price_with_vat DECIMAL(12,2) NULL,
      supply_rate DECIMAL(8,4) NULL,
      discounted_price_with_vat DECIMAL(12,2) NULL,
      cost_price DECIMAL(12,2) NULL,
      vat DECIMAL(12,2) NULL,
      price_sg DECIMAL(12,2) NULL,
      price_tw DECIMAL(12,2) NULL,
      price_my DECIMAL(12,2) NULL,
      price_ph DECIMAL(12,2) NULL,
      price_th DECIMAL(12,2) NULL,
      price_vn DECIMAL(12,2) NULL,
      source_row INT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      synced_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, sku),
      INDEX idx_margin_chart_items_sku (sku),
      INDEX idx_margin_chart_items_active (tenant_id, is_active),
      INDEX idx_margin_chart_items_synced_at (synced_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('margin_chart_items migration applied');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('margin_chart_items migration failed:', err);
    process.exit(1);
  });
