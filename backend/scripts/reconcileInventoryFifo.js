require('dotenv').config();

const db = require('../src/config/database');
const { reconcileInventoryFifo } = require('../src/services/inventoryFifoService');
const { CURRENT_TENANT_ID } = require('../src/config/tenant');

async function main() {
  const result = await reconcileInventoryFifo({ tenantId: CURRENT_TENANT_ID });
  console.log('[InventoryFIFO] reconciliation completed:', JSON.stringify(result));
}

main()
  .catch(err => {
    console.error('[InventoryFIFO] reconciliation failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch (_) {
      // Connection cleanup must not hide the reconciliation result.
    }
  });
