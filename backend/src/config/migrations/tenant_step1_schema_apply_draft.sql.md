# tenant_step1_schema_apply_draft.sql

This is an executable-shape draft for tenant_id=1 schema migration.

DO NOT RUN DIRECTLY WITHOUT FINAL REVIEW.

This draft is based on the production DB precheck results.

Confirmed current unique/index names:
- products: sku
- sku_compositions: uniq_sku_composition
- inventory_batches: uniq_inventory_batch_receipt_sku
- inventory_movements: uniq_inventory_sale
- orders: uq_order_shop

Precheck result summary:
- No existing tenant_id columns in target tables.
- No duplicate products.sku.
- No duplicate sku_compositions(source_sku, base_sku).
- No duplicate inventory_batches(receipt_id, sku).
- No duplicate SALE movement dedupe keys.
- No duplicate orders(order_sn, shop_id).

Important:
- Take a fresh full DB and file backup immediately before execution.
- Execute only during a quiet period.
- Do not run PM2 restart, npm build, or deployment as part of this schema step.
- Backend code currently does not use tenant_id yet, so all tenant_id columns use DEFAULT 1 to preserve current behavior.
- Do not execute this whole draft as one large production script.
- Final execution should be split into smaller reviewed phases:
  1. Create tenants table.
  2. Add tenant_id columns with DEFAULT 1.
  3. Verify row counts and tenant_id backfill.
  4. Add supporting tenant-aware indexes.
  5. Replace unique keys only after duplicate checks pass again.

```sql
USE shopee_dashboard;

-- =========================================================
-- 1. Create tenants table
-- =========================================================

CREATE TABLE IF NOT EXISTS tenants (
  id BIGINT NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tenants_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO tenants (id, code, name, is_active)
VALUES (1, 'GANGNAMCOS', 'GANGNAMCOS', 1)
ON DUPLICATE KEY UPDATE
  code = VALUES(code),
  name = VALUES(name),
  is_active = VALUES(is_active),
  updated_at = NOW();

-- =========================================================
-- 2. Add tenant_id columns with DEFAULT 1
-- =========================================================

ALTER TABLE main_account
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE shops
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE orders
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE order_items
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE products
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE product_cost_history
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE inventory_movements
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE inventory_batches
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE inventory_allocations
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE sku_compositions
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE sync_logs
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE jobs
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

ALTER TABLE shipping_labels
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 AFTER id;

-- =========================================================
-- 3. Replace unique keys with tenant-aware unique keys
-- =========================================================

ALTER TABLE products
  DROP INDEX sku,
  ADD UNIQUE KEY uq_products_tenant_sku (tenant_id, sku);

ALTER TABLE sku_compositions
  DROP INDEX uniq_sku_composition,
  ADD UNIQUE KEY uq_sku_compositions_tenant_source_base
    (tenant_id, source_sku, base_sku);

ALTER TABLE inventory_batches
  DROP INDEX uniq_inventory_batch_receipt_sku,
  ADD UNIQUE KEY uq_inventory_batches_tenant_receipt_sku
    (tenant_id, receipt_id, sku);

ALTER TABLE inventory_movements
  DROP INDEX uniq_inventory_sale,
  ADD UNIQUE KEY uq_inventory_sale_tenant
    (tenant_id, movement_type, order_sn, shop_id, sku, item_id, model_id);

ALTER TABLE orders
  DROP INDEX uq_order_shop,
  ADD UNIQUE KEY uq_orders_tenant_order_shop
    (tenant_id, order_sn, shop_id);

-- =========================================================
-- 4. Add tenant-aware indexes
-- =========================================================

CREATE INDEX idx_main_account_tenant
  ON main_account (tenant_id);

CREATE INDEX idx_shops_tenant_active
  ON shops (tenant_id, is_active);

CREATE INDEX idx_shops_tenant_region
  ON shops (tenant_id, region);

CREATE INDEX idx_shops_tenant_shop
  ON shops (tenant_id, shop_id);

CREATE INDEX idx_orders_tenant_shop_status
  ON orders (tenant_id, shop_id, order_status);

CREATE INDEX idx_orders_tenant_created
  ON orders (tenant_id, order_created_at);

CREATE INDEX idx_orders_tenant_region_date
  ON orders (tenant_id, region, order_created_at);

CREATE INDEX idx_order_items_tenant_order_shop
  ON order_items (tenant_id, order_sn, shop_id);

CREATE INDEX idx_cost_history_tenant_sku_from
  ON product_cost_history (tenant_id, sku, effective_from);

CREATE INDEX idx_movements_tenant_sku
  ON inventory_movements (tenant_id, sku);

CREATE INDEX idx_movements_tenant_order
  ON inventory_movements (tenant_id, order_sn, shop_id);

CREATE INDEX idx_batches_tenant_sku_remaining
  ON inventory_batches (tenant_id, sku, remaining_qty, received_at);

CREATE INDEX idx_allocations_tenant_order
  ON inventory_allocations (tenant_id, order_sn, shop_id);

CREATE INDEX idx_allocations_tenant_sku
  ON inventory_allocations (tenant_id, sku);

CREATE INDEX idx_sync_logs_tenant_shop_type
  ON sync_logs (tenant_id, shop_id, sync_type);

CREATE INDEX idx_jobs_tenant_type_status
  ON jobs (tenant_id, job_type, status);

CREATE INDEX idx_labels_tenant_order_shop
  ON shipping_labels (tenant_id, order_sn, shop_id);

-- =========================================================
-- 5. Post-check queries
-- =========================================================

SELECT tenant_id, COUNT(*) AS cnt FROM shops GROUP BY tenant_id;
SELECT tenant_id, COUNT(*) AS cnt FROM products GROUP BY tenant_id;
SELECT tenant_id, COUNT(*) AS cnt FROM orders GROUP BY tenant_id;
SELECT tenant_id, COUNT(*) AS cnt FROM inventory_movements GROUP BY tenant_id;
SELECT tenant_id, COUNT(*) AS cnt FROM inventory_batches GROUP BY tenant_id;
SELECT tenant_id, COUNT(*) AS cnt FROM sku_compositions GROUP BY tenant_id;

SHOW INDEX FROM products;
SHOW INDEX FROM sku_compositions;
SHOW INDEX FROM inventory_batches;
SHOW INDEX FROM inventory_movements;
SHOW INDEX FROM orders;
```
