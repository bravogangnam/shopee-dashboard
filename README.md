# shopee-dashboard

## Environment variables

- `INVENTORY_FIFO_ENABLED=false`
  - Set to `true` to enable FIFO inventory deduction during order sync.
  - Unset, empty, `false`, `0`, and any value other than `true` keep FIFO deduction disabled.

## Inventory adjustments

- Dashboard stock adjustment (`POST /api/products/:sku/stock/adjust`)
  - Adjusts `products.stock_quantity` only.
  - Records an `inventory_movements` row with `movement_type = 'MANUAL_ADJUST'`.
  - Does not adjust `inventory_batches.remaining_qty`, so it is not for FIFO batch start-balance correction.

- FIFO start balance adjustment (`POST /api/products/:sku/stock/start-balance-adjust`)
  - Lowers both `products.stock_quantity` and `inventory_batches.remaining_qty`.
  - Records a `MANUAL_ADJUST` movement whose note starts with `START_BALANCE_ADJUST`.
  - Use only to align DB stock with the current physical stock before FIFO tracking starts, such as units already packed or sold before `stock_tracking_started_at`.
  - Stock increases should be handled through the receipt management sheet sync, not this endpoint.
