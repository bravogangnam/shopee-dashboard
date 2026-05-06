# tenant_step1_draft.sql

This is a reviewed draft document for the tenant_id=1 SaaS migration plan.

Do not run this SQL directly.

The SQL blocks below are intentionally kept as reviewable draft text.

-- DO NOT RUN DIRECTLY.
-- REVIEW REQUIRED BEFORE PRODUCTION USE.
-- Draft only for tenant_id=1 SaaS migration planning.
-- BACKUP REQUIRED: Full database backup and relevant source file backup before any execution planning.

-- =========================================================
-- STEP 1 DRAFT: tenant_id=1 wrapper for current GANGNAMCOS
-- This is a planning draft, not an executable production migration.
-- Most DDL/DML statements are intentionally commented out.
-- =========================================================

-- 1) tenants table creation draft
-- CREATE TABLE tenants (
--   id BIGINT PRIMARY KEY,
--   code VARCHAR(64) NOT NULL UNIQUE,
--   name VARCHAR(255) NOT NULL,
--   is_active TINYINT(1) NOT NULL DEFAULT 1,
--   created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
--   updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
-- );

-- 2) GANGNAMCOS tenant_id=1 insert draft
-- INSERT INTO tenants (id, code, name, is_active)
-- VALUES (1, 'GANGNAMCOS', 'GANGNAMCOS', 1);

-- 3) add tenant_id to existing tables (draft)
-- ALTER TABLE main_account ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE shops ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE orders ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE order_items ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE products ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE product_cost_history ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE inventory_movements ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE inventory_batches ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE inventory_allocations ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE sku_compositions ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE sync_logs ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE jobs ADD COLUMN tenant_id BIGINT NULL;
-- ALTER TABLE shipping_labels ADD COLUMN tenant_id BIGINT NULL;

-- Optional backfill concept (draft)
-- UPDATE main_account SET tenant_id = 1 WHERE tenant_id IS NULL;
-- UPDATE shops SET tenant_id = 1 WHERE tenant_id IS NULL;
-- UPDATE orders SET tenant_id = 1 WHERE tenant_id IS NULL;
-- ... repeat for all listed tables

-- 4) unique key change drafts
-- products: UNIQUE(sku) -> UNIQUE(tenant_id, sku)
-- sku_compositions: UNIQUE(source_sku, base_sku) -> UNIQUE(tenant_id, source_sku, base_sku)
-- inventory_batches: UNIQUE(receipt_id, sku) -> UNIQUE(tenant_id, receipt_id, sku)
-- inventory_movements: UNIQUE(movement_type, order_sn, shop_id, sku, item_id, model_id) -> include tenant_id
-- orders: UNIQUE(order_sn, shop_id) -> UNIQUE(tenant_id, order_sn, shop_id)

-- 5) index candidates
-- CREATE INDEX idx_shops_tenant_active ON shops (tenant_id, is_active);
-- CREATE INDEX idx_orders_tenant_shop_status ON orders (tenant_id, shop_id, order_status);
-- CREATE INDEX idx_orders_tenant_date ON orders (tenant_id, create_time);
-- CREATE INDEX idx_order_items_tenant_order_shop ON order_items (tenant_id, order_sn, shop_id);
-- CREATE INDEX idx_pch_tenant_sku_effective_from ON product_cost_history (tenant_id, sku, effective_from);
-- CREATE INDEX idx_inventory_movements_tenant_sku_order ON inventory_movements (tenant_id, sku, order_sn);
-- CREATE INDEX idx_inventory_batches_tenant_sku_remaining ON inventory_batches (tenant_id, sku, remaining_qty);
-- CREATE INDEX idx_inventory_allocations_tenant_order_sku ON inventory_allocations (tenant_id, order_sn, sku);
-- CREATE INDEX idx_sync_logs_tenant_shop_type ON sync_logs (tenant_id, shop_id, sync_type);
-- CREATE INDEX idx_jobs_tenant_job_type_status ON jobs (tenant_id, job_type, status);
-- CREATE INDEX idx_shipping_labels_tenant_order_shop ON shipping_labels (tenant_id, order_sn, shop_id);

-- 6) future candidate tables
-- tenant_google_sheet_settings
-- tenant_notification_settings OR telegram_connections
-- exchange_rates can remain global in step 1, then expanded to tenant-level rates later if needed.

-- Reminder:
-- This document is for planning/review only.
-- Do not execute directly in production.
