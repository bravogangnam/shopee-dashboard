const assert = require('assert');
const { collectOrderListPages } = require('../src/services/orderListPagination');

async function run() {
  const cursors = [];
  const result = await collectOrderListPages(async ({ cursor, page }) => {
    cursors.push(cursor);
    if (page === 1) {
      return {
        order_list: [{ order_sn: 'ORDER-1' }, { order_sn: 'ORDER-2' }],
        more: true,
        next_cursor: 'page-2',
      };
    }
    return {
      order_list: [{ order_sn: 'ORDER-2' }, { order_sn: 'ORDER-3' }],
      more: false,
    };
  });

  assert.deepStrictEqual(cursors, ['', 'page-2']);
  assert.deepStrictEqual(result.orderSns, ['ORDER-1', 'ORDER-2', 'ORDER-3']);
  assert.strictEqual(result.pageCount, 2);

  await assert.rejects(
    collectOrderListPages(async () => { throw new Error('shop API failed'); }),
    /shop API failed/
  );

  console.log('order list cursor pagination tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
