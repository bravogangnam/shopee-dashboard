# tenant_step1_precheck.sql

-- DO NOT MODIFY DATA.
-- READ ONLY PRECHECK.
-- Purpose: Validate current DB shape before tenant_id=1 migration execution planning.

-- Backup record note:
-- BACKUP_DB_PATH:
-- BACKUP_FILES_PATH:
-- BACKUP_TIMESTAMP:

-- 1) Table existence checks
SHOW TABLES LIKE 'tenants';
SHOW TABLES LIKE 'main_account';
SHOW TABLES LIKE 'shops';
SHOW TABLES LIKE 'orders';
SHOW TABLES LIKE 'order_items';
SHOW TABLES LIKE 'products';
SHOW TABLES LIKE 'product_cost_history';
SHOW TABLES LIKE 'inventory_movements';
SHOW TABLES LIKE 'inventory_batches';
SHOW TABLES LIKE 'inventory_allocations';
SHOW TABLES LIKE 'sku_compositions';
SHOW TABLES LIKE 'sync_logs';
SHOW TABLES LIKE 'jobs';
SHOW TABLES LIKE 'shipping_labels';

-- 2) Current unique/index checks
SHOW INDEX FROM products;
SHOW INDEX FROM sku_compositions;
SHOW INDEX FROM inventory_batches;
SHOW INDEX FROM inventory_movements;
SHOW INDEX FROM orders;
SHOW INDEX FROM shops;
SHOW INDEX FROM order_items;
SHOW INDEX FROM product_cost_history;
SHOW INDEX FROM inventory_allocations;
SHOW INDEX FROM sync_logs;
SHOW INDEX FROM jobs;
SHOW INDEX FROM shipping_labels;

SELECT
  TABLE_NAME,
  INDEX_NAME,
  NON_UNIQUE,
  SEQ_IN_INDEX,
  COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'products',
    'sku_compositions',
    'inventory_batches',
    'inventory_movements',
    'orders'
  )
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- 3) Verify tenant_id columns are not yet present
SELECT
  TABLE_NAME,
  COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'main_account',
    'shops',
    'orders',
    'order_items',
    'products',
    'product_cost_history',
    'inventory_movements',
    'inventory_batches',
    'inventory_allocations',
    'sku_compositions',
    'sync_logs',
    'jobs',
    'shipping_labels'
  )
  AND COLUMN_NAME = 'tenant_id'
ORDER BY TABLE_NAME;

-- 4) Duplicate risk checks
SELECT sku, COUNT(*) AS cnt
FROM products
GROUP BY sku
HAVING COUNT(*) > 1
ORDER BY cnt DESC, sku
LIMIT 200;

SELECT source_sku, base_sku, COUNT(*) AS cnt
FROM sku_compositions
GROUP BY source_sku, base_sku
HAVING COUNT(*) > 1
ORDER BY cnt DESC, source_sku, base_sku
LIMIT 200;

SELECT receipt_id, sku, COUNT(*) AS cnt
FROM inventory_batches
GROUP BY receipt_id, sku
HAVING COUNT(*) > 1
ORDER BY cnt DESC, receipt_id, sku
LIMIT 200;

SELECT movement_type, order_sn, shop_id, sku, item_id, model_id, COUNT(*) AS cnt
FROM inventory_movements
WHERE movement_type = 'SALE'
GROUP BY movement_type, order_sn, shop_id, sku, item_id, model_id
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 200;

SELECT order_sn, shop_id, COUNT(*) AS cnt
FROM orders
GROUP BY order_sn, shop_id
HAVING COUNT(*) > 1
ORDER BY cnt DESC, order_sn, shop_id
LIMIT 200;

-- 5) Row count snapshot
SELECT 'main_account' AS table_name, COUNT(*) AS row_count FROM main_account
UNION ALL SELECT 'shops', COUNT(*) FROM shops
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'product_cost_history', COUNT(*) FROM product_cost_history
UNION ALL SELECT 'inventory_movements', COUNT(*) FROM inventory_movements
UNION ALL SELECT 'inventory_batches', COUNT(*) FROM inventory_batches
UNION ALL SELECT 'inventory_allocations', COUNT(*) FROM inventory_allocations
UNION ALL SELECT 'sku_compositions', COUNT(*) FROM sku_compositions
UNION ALL SELECT 'sync_logs', COUNT(*) FROM sync_logs
UNION ALL SELECT 'jobs', COUNT(*) FROM jobs
UNION ALL SELECT 'shipping_labels', COUNT(*) FROM shipping_labels;

-- Reminder:
-- This document is read-only planning material.
-- Do not run destructive SQL as part of this precheck.
