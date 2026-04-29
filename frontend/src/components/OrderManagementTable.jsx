import { formatCurrency, formatDateTime } from '../utils/format.js';

function regionClass(region) {
  return `region-badge region-${String(region || '').toLowerCase()}`;
}

function statusClass(status) {
  return `status-pill status-${String(status || '').toLowerCase()}`;
}

function getOrderSn(order) {
  return order.order_sn || order.order_id || order.orderId || '';
}

function getOrderItems(order) {
  const items = order.item_list || order.items || order.order_items || [];
  return Array.isArray(items) ? items : [];
}

function getQuantity(items) {
  return items.reduce((sum, item) => {
    const count = Number(item.model_quantity_purchased || 0);
    return sum + (Number.isFinite(count) ? count : 0);
  }, 0);
}

function getItemImageUrl(item) {
  return (
    item.image_info_image_url ||
    item.item_image_url ||
    item.image_url ||
    item.image ||
    ''
  );
}

export default function OrderManagementTable({
  orders,
  selectedOrders,
  onSelectionChange,
  onFeeDetail,
  onImagePreview,
  loading,
}) {
  const selectedSet = new Set(selectedOrders);
  const allSelected = orders.length > 0 && orders.every(order => selectedSet.has(getOrderSn(order)));

  function toggleAll(checked) {
    onSelectionChange(checked ? orders.map(getOrderSn).filter(Boolean) : []);
  }

  function toggleOne(orderSn, checked) {
    if (!orderSn) return;
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
            <th className="num">수수료</th>
          </tr>
        </thead>
        <tbody>
          {orders.map(order => {
            const items = getOrderItems(order);
            const firstItem = items[0] || {};
            const orderSn = getOrderSn(order);
            const quantity = getQuantity(items) || '-';
            const salesAmount = order.merchandise_subtotal ?? order.total_amount;
            const imgUrl = getItemImageUrl(firstItem);

            return (
              <tr
                key={`${order.shop_id}-${orderSn}`}
                className={order.order_status === 'CANCELLED' ? 'cancelled-row' : ''}
              >
                <td>
                  <input
                    type="checkbox"
                    className="order-checkbox"
                    checked={selectedSet.has(orderSn)}
                    onChange={event => toggleOne(orderSn, event.target.checked)}
                    aria-label={`${orderSn} 선택`}
                  />
                </td>
                <td>
                  <strong>{orderSn}</strong>
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
                  <div
                    className={`truncate-short ${imgUrl ? 'clickable' : ''}`}
                    title={firstItem.model_name || ''}
                    onClick={() => {
                      if (imgUrl) onImagePreview({ ...firstItem, image_url: imgUrl });
                    }}
                    style={{ cursor: imgUrl ? 'pointer' : 'default' }}
                  >
                    {firstItem.model_name || '-'}
                  </div>
                </td>
                <td className="num">{quantity}</td>
                <td className="num">{formatCurrency(salesAmount, order.currency)}</td>
                <td className="num">
                  <button
                    type="button"
                    className="fee-detail-btn"
                    onClick={() => onFeeDetail(order)}
                    title="수수료 상세"
                  >
                    ⓘ
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
