# Shipping label retention

Shopee Dashboard continues to use the official Shopee invoice flow:

1. Create an invoice job with `POST /api/invoices/jobs`.
2. Download the official Shopee AWB/shipping document.
3. Crop the official invoice into the printer format.
4. Store individual official PDFs under `data/shipping-labels/<shop_id>/`.
5. Create a merged PDF under `data/shipping-labels/_merged/` for download through `GET /api/invoices/jobs/:jobId/download`.

## Retention policy

- Individual official Shopee invoice PDFs are kept for 45 days by default.
- Set `SHIPPING_LABEL_RETENTION_DAYS` to override the retention period.
- Missing, non-numeric, zero, or negative retention values fall back to 45 days.
- Merged PDFs under `data/shipping-labels/_merged/` are not retained permanently and are always cleanup targets.
- Cleanup deletes invoice PDF files only. It does not delete orders, order items, FIFO allocation data, inventory data, settlement data, or ledger data.

## Cleanup triggers

- Manual: settings page button calls `POST /api/settings/shipping-labels/cleanup`.
- Automatic: backend schedules a daily cleanup job at startup.

The removed experimental self-generated Code 128 packing label flow is not an active invoice path.
