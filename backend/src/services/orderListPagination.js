async function collectOrderListPages(fetchPage, { sleepFn = async () => {} } = {}) {
  let cursor = '';
  let pageCount = 0;
  const orderSns = [];

  while (true) {
    pageCount += 1;
    const response = await fetchPage({ cursor, page: pageCount });
    orderSns.push(...(response?.order_list || []).map(order => order.order_sn));
    if (!response?.more || !response?.next_cursor) break;
    cursor = response.next_cursor;
    await sleepFn(500);
  }

  return { orderSns: Array.from(new Set(orderSns)), pageCount };
}

module.exports = { collectOrderListPages };
