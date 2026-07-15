# Shopee Shop Profile Sync

Settings now separates the user's internal shop alias from Shopee's real shop profile fields.

## Database fields

Run `node backend/scripts/applyShopProfileFieldsMigration.js` before using the feature on an existing database.

The migration safely adds missing columns only:

- `shops.shop_name VARCHAR(255) NULL`
- `shops.shop_logo_url VARCHAR(1000) NULL`
- `shops.shop_info_synced_at DATETIME NULL`

`shops.alias` remains the user-managed internal alias and is never overwritten by automatic profile sync.

## Shopee endpoints

Profile sync uses existing shop-level signing and each shop's `shops.access_token`:

- `/api/v2/shop/get_profile` for `response.shop_name` and `response.shop_logo`
- `/api/v2/shop/get_shop_info` for `response.region` (fallback `response.country`)

## Sync entry points

- OAuth callback: after `shop_id_list` tokens are saved by `syncOAuthShopList`, the callback runs profile sync for the discovered shop IDs. OAuth success is not rolled back when one shop profile fails.
- Manual settings action: `POST /api/settings/shops/sync-profile` syncs active shops for the current tenant only.

The manual endpoint returns `{ total, updated, failed, results }`; each result contains `shop_id`, `success`, and synced fields or a safe error message.

## Display precedence

Settings API includes `display_name = alias || shop_name || shop_id`. The settings table shows Shopee shop name and internal alias as separate columns.
