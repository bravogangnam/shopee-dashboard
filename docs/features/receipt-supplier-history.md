# Receipt supplier history

The receipt management page stores supplier input on `stock_receipts.supplier` for pending receipts.

When a pending receipt is completed, the completion flow copies that supplier to `inventory_batches.supplier` on the generated FIFO batch. This keeps the completed receipt history tied to the exact batch without changing FIFO quantities, remaining quantity, unit cost, inventory movements, or allocation logic.

## Migration

Run this idempotent migration before deploying the backend change:

```bash
node backend/scripts/applyInventoryBatchSupplierMigration.js
```

The script adds `inventory_batches.supplier VARCHAR(255) NULL` only when the column does not already exist.

## Display behavior

- Recent receipt history API returns `supplier` from `inventory_batches.supplier`.
- If the batch supplier is empty, the API falls back to the matching `stock_receipts.supplier` by `tenant_id + receipt_code`.
- Historical rows with no reliable supplier remain blank and are shown as `-` in the frontend.
- All receipt history queries keep the existing `tenant_id` filter.
