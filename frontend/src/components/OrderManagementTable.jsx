import { formatCurrency, formatDateTime } from '../utils/format.js';

function regionClass(region) {
  return `region-badge region-${String(region || '').toLowerCase()}`;
}

function statusClass(status) {
  return `status-pill status-${String(status || '').toLowerCase()}`;
}

function isTwKycPending(order) {
  return (
    order?.region === 'TW' &&
    order?.order_status === 'READY_TO_SHIP' &&
    !order?.tracking_number
  );
}

function getDisplayStatus(order) {
  return order?.display_status || order?.order_status;
}

function orderStatusLabel(status) {
  const labels = {
    UNPAID: '결제 대기',
    PENDING: '펜딩',
    READY_TO_SHIP: '발송 대기',
    PROCESSED: '발송 처리',
    RETRY_SHIP: '재배송',
    SHIPPED: '배송 중',
    TO_CONFIRM_RECEIVE: '수취 확인',
    COMPLETED: '배송 완료',
    IN_CANCEL: '취소 요청',
    TO_RETURN: '반품/환불',
    CANCELLED: '취소 완료',
  };

  return labels[status] || status || '-';
}

function getOrderSn(order) {
  return order.order_sn || order.order_id || order.orderId || '';
}

function getOrderItems(order) {
  const items = order.item_list || order.items || order.order_items || [];
  return Array.isArray(items) ? items : [];
}

function getItemProductName(item, order) {
  return (
    item.product_name ||
    item.item_name ||
    item.product_name_en ||
    item.name ||
    order.product_name ||
    '-'
  );
}

function getItemOptionName(item) {
  return (
    item.model_name ||
    item.option_name ||
    item.variation_name ||
    item.model_sku ||
    '-'
  );
}

function getItemQuantity(item, order) {
  const value =
    item.model_quantity_purchased ??
    item.quantity ??
    item.qty ??
    order.quantity ??
    1;
  const number = Number(value);
  return Number.isFinite(number) ? number : value || '-';
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

function renderProductLines(items, order, onOrderDetail) {
  const sourceItems = items.length ? items : [{}];
  return (
    <div className="order-item-lines">
      {sourceItems.map((item, index) => (
        <button
          type="button"
          className="order-item-line order-product-line order-product-detail-button"
          key={`${item.item_id || 'item'}-${item.model_id || index}-${index}`}
          title={getItemProductName(item, order)}
          aria-label={`${getOrderSn(order)} ${getItemProductName(item, order)} 주문 정산 상세 보기`}
          onClick={() => onOrderDetail(order)}
        >
          {getItemProductName(item, order)}
        </button>
      ))}
    </div>
  );
}

function renderOptionLines(items, onImagePreview) {
  const sourceItems = items.length ? items : [{}];
  return (
    <div className="order-item-lines">
      {sourceItems.map((item, index) => {
        const imgUrl = getItemImageUrl(item);
        const optionName = getItemOptionName(item);
        return (
          <div
            className={`order-item-line order-option-line ${imgUrl ? 'clickable' : ''}`}
            key={`${item.item_id || 'option'}-${item.model_id || index}-${index}`}
            title={optionName}
            onClick={() => {
              if (imgUrl && onImagePreview) {
                onImagePreview({ ...item, image_url: imgUrl });
              }
            }}
          >
            {optionName}
          </div>
        );
      })}
    </div>
  );
}

function renderQuantityLines(items, order) {
  const sourceItems = items.length ? items : [{}];
  return (
    <div className="order-item-lines">
      {sourceItems.map((item, index) => (
        <div
          className="order-item-line"
          key={`${item.item_id || 'qty'}-${item.model_id || index}-${index}`}
        >
          {getItemQuantity(item, order)}
        </div>
      ))}
    </div>
  );
}

export default function OrderManagementTable({
  orders,
  selectedOrders,
  onSelectionChange,
  onOrderDetail,
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
          </tr>
        </thead>
        <tbody>
          {orders.map(order => {
            const items = getOrderItems(order);
            const orderSn = getOrderSn(order);
            const salesAmount = order.merchandise_subtotal ?? order.total_amount;

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
                <td>
                  <span className={statusClass(getDisplayStatus(order))}>
                    {orderStatusLabel(getDisplayStatus(order))}
                  </span>
                </td>
                <td>{renderProductLines(items, order, onOrderDetail)}</td>
                <td>{renderOptionLines(items, onImagePreview)}</td>
                <td className="num">{renderQuantityLines(items, order)}</td>
                <td className="num">{formatCurrency(salesAmount, order.currency)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
