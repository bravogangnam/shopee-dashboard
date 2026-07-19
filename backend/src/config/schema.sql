USE shopee_dashboard;

CREATE TABLE IF NOT EXISTS main_account (
    id                  INT PRIMARY KEY AUTO_INCREMENT,
    partner_id          BIGINT NOT NULL,
    partner_key         VARCHAR(200) NOT NULL,
    main_account_id     BIGINT,
    merchant_id         BIGINT,
    access_token        TEXT,
    refresh_token       TEXT,
    token_expires_at    DATETIME,
    refresh_expires_at  DATETIME,
    token_status        ENUM('active','expired') DEFAULT 'active',
    created_at          DATETIME DEFAULT NOW(),
    updated_at          DATETIME DEFAULT NOW() ON UPDATE NOW()
);

CREATE TABLE IF NOT EXISTS shops (
    id                 INT PRIMARY KEY AUTO_INCREMENT,
    main_account_id    INT NOT NULL,
    shop_id            BIGINT NOT NULL,
    shop_name          VARCHAR(200),
    region             VARCHAR(5),
    alias              VARCHAR(50),
    is_active          TINYINT(1) DEFAULT 0,
    created_at         DATETIME DEFAULT NOW(),
    updated_at         DATETIME DEFAULT NOW() ON UPDATE NOW(),
    UNIQUE KEY (shop_id)
);

INSERT IGNORE INTO shops (main_account_id, shop_id, alias, region, is_active) VALUES
(1, 1592998908, 'SG', 'SG', 1),
(1, 1607024749, 'MY', 'MY', 1),
(1, 1607024761, 'TW', 'TW', 1),
(1, 1607024752, NULL, NULL, 0),
(1, 1607024756, NULL, NULL, 0),
(1, 1607024757, NULL, NULL, 0),
(1, 1607024772, NULL, NULL, 0),
(1, 1607024780, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS orders (
    id                              INT PRIMARY KEY AUTO_INCREMENT,
    shop_id                         BIGINT NOT NULL,
    region                          VARCHAR(5),
    order_sn                        VARCHAR(50) NOT NULL,
    order_status                    VARCHAR(30),
    is_final_status                 TINYINT(1) DEFAULT 0,
    merchandise_subtotal            DECIMAL(12,2),
    total_amount                    DECIMAL(12,2),
    currency                        VARCHAR(10),
    original_price                  DECIMAL(12,2),
    seller_discount                 DECIMAL(12,2),
    voucher_from_seller             DECIMAL(12,2),
    voucher_from_shopee             DECIMAL(12,2),
    coins_offset                    DECIMAL(12,2),
    buyer_total_amount              DECIMAL(12,2),
    payment_method                  VARCHAR(100),
    shipping_carrier                VARCHAR(100),
    checkout_shipping_carrier       VARCHAR(255),
    tracking_number                 VARCHAR(100),
    shipping_fee                    DECIMAL(12,2),
    shipping_fee_discount           DECIMAL(12,2),
    actual_shipping_fee             DECIMAL(12,2),
    estimated_shipping_fee          DECIMAL(12,2),
    order_chargeable_weight_gram    INT,
    commission_fee                  DECIMAL(12,2),
    service_fee                     DECIMAL(12,2),
    transaction_fee                 DECIMAL(12,2),
    escrow_amount                   DECIMAL(12,2),
    create_time                     INT,
    order_created_at                DATETIME,
    update_time                     INT,
    synced_at                       DATETIME DEFAULT NOW(),
    UNIQUE KEY uq_order_shop (order_sn, shop_id),
    INDEX idx_shop_status (shop_id, order_status),
    INDEX idx_order_created (order_created_at),
    INDEX idx_final_status (is_final_status),
    INDEX idx_region_date (region, order_created_at)
);

CREATE TABLE IF NOT EXISTS order_items (
    id                          INT PRIMARY KEY AUTO_INCREMENT,
    order_sn                    VARCHAR(50) NOT NULL,
    shop_id                     BIGINT NOT NULL,
    item_id                     BIGINT,
    item_name                   VARCHAR(500),
    item_sku                    VARCHAR(100),
    model_id                    BIGINT,
    model_name                  VARCHAR(200),
    model_sku                   VARCHAR(100),
    model_quantity_purchased    INT,
    model_original_price        DECIMAL(12,2),
    model_discounted_price      DECIMAL(12,2),
    image_info_image_url        VARCHAR(500),
    item_image_url              VARCHAR(500),
    INDEX idx_order_shop (order_sn, shop_id)
);

CREATE TABLE IF NOT EXISTS shipping_labels (
    id                INT PRIMARY KEY AUTO_INCREMENT,
    order_sn          VARCHAR(50) NOT NULL,
    shop_id           BIGINT NOT NULL,
    file_path         VARCHAR(500) NOT NULL,
    label_format      VARCHAR(10) DEFAULT 'PDF',
    file_size_bytes   INT,
    tracking_number   VARCHAR(100),
    cached_at         DATETIME DEFAULT NOW(),
    UNIQUE KEY uq_label_order (order_sn, shop_id)
);

CREATE TABLE IF NOT EXISTS jobs (
    id                VARCHAR(36) PRIMARY KEY,
    job_type          ENUM('sync','backfill','invoice') NOT NULL,
    status            ENUM('pending','running','completed','failed') DEFAULT 'pending',
    progress_total    INT DEFAULT 0,
    progress_current  INT DEFAULT 0,
    progress_message  VARCHAR(500),
    result_data       JSON,
    error_message     TEXT,
    created_at        DATETIME DEFAULT NOW(),
    updated_at        DATETIME DEFAULT NOW() ON UPDATE NOW(),
    INDEX idx_status (status),
    INDEX idx_type_status (job_type, status)
);

CREATE TABLE IF NOT EXISTS sync_logs (
    id                INT PRIMARY KEY AUTO_INCREMENT,
    shop_id           BIGINT NOT NULL,
    sync_type         ENUM('backfill','manual') DEFAULT 'manual',
    sync_window_start DATETIME,
    sync_window_end   DATETIME,
    orders_fetched    INT DEFAULT 0,
    orders_updated    INT DEFAULT 0,
    status            ENUM('success','fail') DEFAULT 'success',
    error_message     TEXT,
    created_at        DATETIME DEFAULT NOW(),
    INDEX idx_shop_window (shop_id, sync_window_end),
    INDEX idx_shop_type (shop_id, sync_type)
);

CREATE TABLE IF NOT EXISTS exchange_rates (
    id                INT PRIMARY KEY AUTO_INCREMENT,
    currency          VARCHAR(10) NOT NULL,
    rate_to_krw       DECIMAL(10,2) NOT NULL,
    updated_at        DATETIME DEFAULT NOW() ON UPDATE NOW(),
    UNIQUE KEY uq_currency (currency)
);

INSERT IGNORE INTO exchange_rates (currency, rate_to_krw) VALUES
('SGD', 1100.00),
('MYR', 360.00),
('TWD', 44.50);

-- ========================================
-- 상품/재고 관리 스키마
-- ========================================
CREATE TABLE IF NOT EXISTS products (
    id                              INT AUTO_INCREMENT PRIMARY KEY,
    sku                             VARCHAR(100) UNIQUE NOT NULL,
    brand                           VARCHAR(200),
    product_name_en                 TEXT,
    option_name                     VARCHAR(200),
    product_name_kr                 VARCHAR(200),
    weight                          DECIMAL(8,2),
    cost_price_with_vat             DECIMAL(12,2),
    supply_rate                     DECIMAL(5,2),
    discounted_price_with_vat       DECIMAL(12,2),
    cost_price                      DECIMAL(12,2),
    vat                             DECIMAL(12,2),
    stock_quantity                  INT NOT NULL DEFAULT 0,
    low_stock_threshold             INT NOT NULL DEFAULT 3,
    stock_tracking_started_at       DATETIME NULL,
    created_at                      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at                      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  CREATE TABLE IF NOT EXISTS inventory_movements (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    sku             VARCHAR(100) NOT NULL,
    order_sn        VARCHAR(50) NULL,
    shop_id         BIGINT NULL,
    item_id         BIGINT NULL,
    model_id        BIGINT NULL,
    movement_type   ENUM('SALE','CANCEL_RESTORE','MANUAL_ADJUST','STOCK_IN') NOT NULL,
    qty_delta       INT NOT NULL,
    note            VARCHAR(255) NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_inventory_sale (movement_type, order_sn, shop_id, sku, item_id, model_id),
    INDEX idx_inventory_sku (sku),
    INDEX idx_inventory_order (order_sn, shop_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  CREATE TABLE IF NOT EXISTS inventory_cancellation_reviews (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      shop_id BIGINT NOT NULL,
      order_sn VARCHAR(50) NOT NULL,
      previous_order_status VARCHAR(30) NOT NULL,
      decision VARCHAR(30) NOT NULL,
      decision_reason VARCHAR(255) NOT NULL,
      cancelled_update_time BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      resolved_at DATETIME NULL,
      UNIQUE KEY uq_inventory_cancellation_review (tenant_id, shop_id, order_sn),
      INDEX idx_inventory_cancellation_decision (tenant_id, decision, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 운영 DB에 기존 inventory_movements 테이블이 있으면 아래 ALTER를 수동 실행:
-- ALTER TABLE inventory_movements
--   MODIFY movement_type ENUM('SALE', 'CANCEL_RESTORE', 'MANUAL_ADJUST', 'STOCK_IN') NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_batches (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    receipt_id          VARCHAR(100) NOT NULL,
    receipt_no          INT NULL,
    source_sku          VARCHAR(100) NOT NULL,
    sku                 VARCHAR(100) NOT NULL,
    received_at         DATETIME NULL,
    receipt_type        VARCHAR(50) NULL,
    initial_qty         INT NOT NULL,
    remaining_qty       INT NOT NULL,
    unit_cost           DECIMAL(12,2) NOT NULL DEFAULT 0,
    source_unit_cost    DECIMAL(12,2) NULL,
    conversion_factor   DECIMAL(12,4) NOT NULL DEFAULT 1,
    note                VARCHAR(255) NULL,
    sheet_row           INT NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_inventory_batch_receipt_sku (receipt_id, sku),
    INDEX idx_inventory_batches_sku (sku),
    INDEX idx_inventory_batches_receipt (receipt_id),
    INDEX idx_inventory_batches_remaining (sku, remaining_qty, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sku_compositions (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    source_sku          VARCHAR(100) NOT NULL,
    base_sku            VARCHAR(100) NOT NULL,
    factor              DECIMAL(12,4) NOT NULL DEFAULT 1,
    composition_type    VARCHAR(50) NULL,
    note                VARCHAR(255) NULL,
    sheet_row           INT NULL,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_sku_composition (source_sku, base_sku),
    INDEX idx_sku_compositions_source (source_sku),
    INDEX idx_sku_compositions_base (base_sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inventory_allocations (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    movement_id     INT NOT NULL,
    batch_id        INT NOT NULL,
    order_sn        VARCHAR(50) NULL,
    shop_id         BIGINT NULL,
    source_sku      VARCHAR(100) NULL,
    sku             VARCHAR(100) NOT NULL,
    qty             INT NOT NULL,
    unit_cost       DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_cost      DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_inventory_allocation (movement_id, batch_id),
    INDEX idx_inventory_allocations_order (order_sn, shop_id),
    INDEX idx_inventory_allocations_sku (sku),
    INDEX idx_inventory_allocations_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_alert_deliveries (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id       INT NOT NULL,
    shop_id         BIGINT NOT NULL,
    order_sn        VARCHAR(50) NOT NULL,
    alert_type      VARCHAR(30) NOT NULL,
    status          ENUM('processing','sent','failed') NOT NULL DEFAULT 'processing',
    attempts        INT NOT NULL DEFAULT 1,
    error_message   VARCHAR(500) NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    sent_at         DATETIME NULL,
    UNIQUE KEY uq_order_alert_delivery (tenant_id, shop_id, order_sn, alert_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shopee_push_events (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id           INT NOT NULL,
    shop_id             BIGINT NOT NULL,
    code                INT NOT NULL,
    order_sn            VARCHAR(50) NULL,
    event_update_time   BIGINT NULL,
    payload_hash        CHAR(64) NOT NULL,
    status              ENUM('queued','processing','completed','failed','ignored') NOT NULL DEFAULT 'queued',
    error_message       VARCHAR(500) NULL,
    received_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at        DATETIME NULL,
    UNIQUE KEY uq_shopee_push_payload (shop_id, code, payload_hash),
    INDEX idx_shopee_push_order (tenant_id, shop_id, order_sn, event_update_time),
    INDEX idx_shopee_push_status (status, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
