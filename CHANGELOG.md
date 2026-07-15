# Changelog

- Removed the Shopee Dashboard Mass Upload / KRSC feature, including its frontend route/menu, backend shopee-meta runtime routes, dedicated source files, CSS, and xlsx dependencies. Product Capture and the separate Mass Upload Tool repository are unchanged.
## Unreleased

- Added Shopee shop profile sync after OAuth shop token registration and via `POST /api/settings/shops/sync-profile`.
- Added safe migration script for `shops.shop_name`, `shops.shop_logo_url`, and `shops.shop_info_synced_at` while preserving `shops.alias` as an internal alias.
- Updated settings shop management UI to show Shop ID, Shopee shop name, internal alias, region, connection status, sync timestamp, and a manual profile sync button.
- Removed the experimental self-generated Code 128 packing label flow; official Shopee invoice output remains the only active invoice path.
- Added manual and daily cleanup for invoice PDF files: merged PDFs are removed, and individual official Shopee invoice PDFs older than `SHIPPING_LABEL_RETENTION_DAYS` are deleted with a safe 45-day default.
- Added supplier display for recent receipt history and a safe migration for `inventory_batches.supplier`.
