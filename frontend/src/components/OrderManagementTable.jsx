import { formatCurrency, formatDateTime } from '../utils/format.js';

function regionClass(region) {
  return `region-badge region-${String(region || '').toLowerCase()}`;
}

function statusClass(status) {
  return `status-pill status-${String(status || '').toLowerCase()}`;
}

function getQuantity(items) {
  return items.reduce((sum, item) => {
    const count = Number(item.model_quantity_purchased || 0);
    return sum + (Number.isFinite(count) ? count : 0);
  }, 0);
}

export default function OrderManagementTable({
  orders,
  selectedOrders,
  onSelectionChange,
  onInvoiceOne,
  loading,
  invoiceLoadingMap,
}) {
  const selectedSet = new Set(selectedOrders);
  const allSelected = orders.length > 0 && orders.every(order => selectedSet.has(order.order_sn));

  function toggleAll(checked) {
    onSelectionChange(checked ? orders.map(order => order.order_sn) : []);
  }

  function toggleOne(orderSn, checked) {
    if (checked) {
      onSelectionChange([...selectedSet, orderSn]);
    } else {
      onSelectionChange(selectedOrders.filter(value => value !== orderSn));
    }
  }

  if (loading) {
    return <div className="table-state">주문을 불러오는 중...</div>;
  }

  if (!orders.length) {
    return <div className="table-state">조회된 주문이 없습니다.</div>;
  }

  return (
    <div className="table-wrap order-management-table-wrap">
      <table className="data-table order-management-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                className="order-checkbox"
                checked={allSelected}
                onChange={event => toggleAll(event.target.checked)}
                aria-label="전체 선택"
              />
            </th>
            <th>Order ID</th>
            <th>Shop</th>
            <th>Order Status</th>
            <th>상품명</th>
            <th>옵션명</th>
            <th className="num">수량</th>
            <th className="num">판매가</th>
            <th>송장</th>
          </tr>
        </thead>
        <tbody>
          {orders.map(order => {
            const items = Array.isArray(order.item_list) ? order.item_list : [];
            const firstItem = items[0] || {};
            const quantity = getQuantity(items) || '-';
            const salesAmount = order.merchandise_subtotal ?? order.total_amount;
            const disabled = Boolean(invoiceLoadingMap[order.order_sn]);

            return (
              <tr
                key={`${order.shop_id}-${order.order_sn}`}
                className={order.order_status === 'CANCELLED' ? 'cancelled-row' : ''}
              >
                <td>
                  <input
                    type="checkbox"
                    className="order-checkbox"
                    checked={selectedSet.has(order.order_sn)}
                    onChange={event => toggleOne(order.order_sn, event.target.checked)}
                    aria-label={`${order.order_sn} 선택`}
                  />
                </td>
                <td>
                  <strong>{order.order_sn}</strong>
                  <small>{formatDateTime(order.order_created_at)}</small>
                </td>
                <td>
                  <span className={regionClass(order.region)}>{order.region || order.shop_alias || order.shop_id}</span>
                </td>
                <td><span className={statusClass(order.order_status)}>{order.order_status}</span></td>
                <td>
                  <div className="truncate" title={firstItem.item_name || ''}>
                    {firstItem.item_name || '-'}
                  </div>
                </td>
                <td>
                  <div className="truncate-short" title={firstItem.model_name || ''}>
                    {firstItem.model_name || '-'}
                  </div>
                </td>
                <td className="num">{quantity}</td>
                <td className="num">{formatCurrency(salesAmount, order.currency)}</td>
                <td>
                  <button
                    type="button"
                    className="invoice-btn"
                    onClick={() => onInvoiceOne(order.order_sn)}
                    disabled={disabled}
                  >
                    {disabled ? '처리중' : '출력'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
