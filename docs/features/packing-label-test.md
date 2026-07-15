# Test Packing Label PDF

The official Shopee invoice/AWB flow remains the default. The order page adds a separate **테스트 송장 출력** action for a non-verified packing label that is generated from the stored `orders.tracking_number`.

## Data source and safety

- Orders are selected by `tenant_id` and `order_sn` only.
- Items are selected from `order_items` by the same `tenant_id` and order list.
- Shop labels use `shops.alias || shops.shop_name || shop_id` with `shops.region || orders.region`.
- If any selected order has no `tracking_number`, test label generation fails with `TRACKING_NUMBER_MISSING` and the existing official invoice flow remains available.

## Barcode/QR

- Tracking number barcode: Code 128 via `bwip-js` (`bcid: code128`) without changing case, spacing, or checksum.
- Order ID QR: `bwip-js` (`bcid: qrcode`).
- The test label includes `TEST PACKING LABEL - NOT VERIFIED` until scan verification is complete.

## File policy

Generated PDFs are streamed to the browser. A temporary copy may be written under `data/tmp/packing-labels` and is deleted after the response finishes; old temp files are purged opportunistically. Existing `data/shipping-labels/<shop_id>/` official labels and `_merged` PDFs are not modified.
