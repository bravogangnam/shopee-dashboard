# Changelog

## Unreleased

- Added Shopee shop profile sync after OAuth shop token registration and via `POST /api/settings/shops/sync-profile`.
- Added safe migration script for `shops.shop_name`, `shops.shop_logo_url`, and `shops.shop_info_synced_at` while preserving `shops.alias` as an internal alias.
- Updated settings shop management UI to show Shop ID, Shopee shop name, internal alias, region, connection status, sync timestamp, and a manual profile sync button.
