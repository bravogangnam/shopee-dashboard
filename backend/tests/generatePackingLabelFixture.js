const fs = require('fs');
const path = require('path');
const { buildPackingLabelsPdfFromOrders } = require('../src/services/packingLabelService');

async function run() {
  const outDir = path.resolve(__dirname, '../../data/tmp/packing-labels');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'test-packing-label-MY264141281894Q.pdf');
  const { buffer } = await buildPackingLabelsPdfFromOrders([
    {
      order_sn: '250715TESTORDER',
      shop_id: 1592998908,
      region: 'MY',
      shop_region: 'MY',
      shop_name: 'GANGNAMCOS',
      tracking_number: 'MY264141281894Q',
      items: [
        { item_name: '강남 테스트 상품', model_name: 'Black / L', sku: 'GS_02000', quantity: 2 },
        { item_name: 'Sample English Product', model_name: 'Option A', sku: 'GS_02001', quantity: 1 },
      ],
    },
  ]);
  fs.writeFileSync(outPath, buffer);
  console.log(outPath);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
