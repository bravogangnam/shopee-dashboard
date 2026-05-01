# shopee-dashboard

## Environment variables

- `INVENTORY_FIFO_ENABLED=false`
  - Set to `true` to enable FIFO inventory deduction during order sync.
  - Unset, empty, `false`, `0`, and any value other than `true` keep FIFO deduction disabled.

- `PURCHASE_ALERT_ENABLED=false`
  - Set to `true` to enable purchase-needed alerts.
  - Alerts are skipped unless this is exactly `true`.
- `PURCHASE_ALERT_CHANNEL=telegram`
  - First supported alert channel.
- `TELEGRAM_BOT_TOKEN=`
  - Telegram bot token for purchase-needed alerts.
- `TELEGRAM_CHAT_ID=`
  - Telegram chat id for purchase-needed alerts.

## Invoice jobs

- Invoice jobs are stored in the `jobs` table and use `pending`, `running`, `completed`, and `failed` DB statuses.
- API responses may expose `partial_failed` when a completed invoice job has at least one generated PDF and at least one failed/skipped order.
- Stale running invoice jobs are auto-recovered after 10 minutes before starting a new invoice job and on server startup.
- Manual stuck-job reset SQL, for emergency use only:

```sql
UPDATE jobs
SET status='failed',
    error_message='manual reset: invoice job stuck',
    progress_message='수동 해제됨',
    updated_at=NOW()
WHERE job_type='invoice'
  AND status='running'
  AND updated_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE);
```

## Inventory adjustments

- `products.stock_quantity`
  - Represents sellable stock.
  - Can be negative when orders arrive before enough stock has been received.
  - A negative value means purchase-needed stock that still needs receipt allocation.
  - 구매필요: `products.stock_quantity < 0`. Orders exist, but purchase/receipt is still required.

- `inventory_batches.remaining_qty`
  - Represents physical FIFO batch balance.
  - Must never be negative.

- Receipt sync
  - Increases `products.stock_quantity`.
  - Creates FIFO batches from the receipt management sheet.
  - Automatically allocates newly created batch quantity to older open SALE shortages for the same SKU.

- Shortage reconciliation script
  - Dry-run: `node backend/scripts/reconcileInventoryShortages.js --dry-run`
  - Single SKU dry-run: `node backend/scripts/reconcileInventoryShortages.js --dry-run --sku GS_01239`
  - Apply only after review: `node backend/scripts/reconcileInventoryShortages.js --apply`
  - Recalculates target stock as `SUM(inventory_batches.remaining_qty) - open_shortage_qty`.

- Dashboard stock adjustment (`POST /api/products/:sku/stock/adjust`)
  - Adjusts `products.stock_quantity` only.
  - Records an `inventory_movements` row with `movement_type = 'MANUAL_ADJUST'`.
  - Does not adjust `inventory_batches.remaining_qty`, so it is not for FIFO batch start-balance correction.

- FIFO start balance adjustment (`POST /api/products/:sku/stock/start-balance-adjust`)
  - Lowers both `products.stock_quantity` and `inventory_batches.remaining_qty`.
  - Records a `MANUAL_ADJUST` movement whose note starts with `START_BALANCE_ADJUST`.
  - Use only to align DB stock with the current physical stock before FIFO tracking starts, such as units already packed or sold before `stock_tracking_started_at`.
  - Stock increases should be handled through the receipt management sheet sync, not this endpoint.
