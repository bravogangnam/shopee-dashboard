function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

function getOrderSn(order) {
  return order.order_sn || order.order_id || order.orderId || '';
}

function getItems(order) {
  const items = order.item_list || order.items || order.order_items || [];
  return Array.isArray(items) ? items : [];
}

function regionClass(region) {
  return `region-badge region-${String(region || '').toLowerCase()}`;
}

function statusClass(status) {
  return `status-pill status-${String(status || '').toLowerCase()}`;
}

function fmtAmount(value, currency, krwRate) {
  if (!isPresent(value)) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  const rate = Number(krwRate || 0);
  const krw = Math.round(num * (Number.isFinite(rate) ? rate : 0));
  return `${num.toFixed(2)} ${currency}  (₩${krw.toLocaleString('ko-KR')})`;
}

function display(value) {
  return isPresent(value) ? value : '-';
}

function FeeRows({ rows }) {
  const visibleRows = rows.filter(row => !row.optional || isPresent(row.value));
  if (!visibleRows.length) return null;

  return (
    <table className="fee-table">
      <tbody>
        {visibleRows.map(row => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td>{row.render ? row.render(row.value) : display(row.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function FeeDetailModal({ order, onClose }) {
  if (!order) return null;

  const orderSn = getOrderSn(order);
  const items = getItems(order);
  const currency = order.currency || order.currency_code || order.region || '';
  const krwRate =
    order.krw_rate ||
    order.rate_to_krw ||
    order.exchange_rate ||
    order.exchangeRate ||
    0;
  const amount = value => fmtAmount(value, currency, krwRate);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content fee-detail-modal" onClick={event => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
          ✕
        </button>

        <div className="fee-modal-title">
          <span>ⓘ 수수료 상세</span>
          <strong>{orderSn}</strong>
        </div>

        <FeeRows
          rows={[
            { label: 'Order ID', value: orderSn },
            {
              label: 'Order Status',
              value: order.order_status,
              render: value => <span className={statusClass(value)}>{display(value)}</span>,
            },
            {
              label: 'Shop',
              value: order.region || order.shop_alias || order.shop_id,
              render: value => <span className={regionClass(order.region)}>{display(value)}</span>,
            },
            { label: 'Currency', value: currency },
            {
              label: '환율',
              value: krwRate,
              render: value => (Number(value) ? `1 ${currency} = ₩${Number(value).toLocaleString('ko-KR')}` : '-'),
            },
          ]}
        />

        <div className="fee-section-title">매출 관련</div>
        <FeeRows
          rows={[
            { label: 'merchandise_subtotal', value: order.merchandise_subtotal, render: amount },
            { label: 'total_amount', value: order.total_amount, render: amount },
            { label: 'original_price', value: order.original_price, render: amount, optional: true },
            { label: 'buyer_total_amount', value: order.buyer_total_amount, render: amount, optional: true },
            { label: 'seller_discount', value: order.seller_discount, render: amount, optional: true },
            { label: 'voucher_from_seller', value: order.voucher_from_seller, render: amount, optional: true },
            { label: 'voucher_from_shopee', value: order.voucher_from_shopee, render: amount, optional: true },
          ]}
        />

        <div className="fee-section-title">배송비</div>
        <FeeRows
          rows={[
            { label: 'estimated_shipping_fee', value: order.estimated_shipping_fee, render: amount },
            { label: 'actual_shipping_fee', value: order.actual_shipping_fee, render: amount },
            {
              label: 'order_chargeable_weight_gram',
              value: order.order_chargeable_weight_gram,
              render: value => (Number(value) ? `${Number(value).toLocaleString('ko-KR')} g` : '-'),
            },
          ]}
        />

        <div className="fee-section-title">플랫폼 수수료</div>
        <FeeRows
          rows={[
            { label: 'commission_fee', value: order.commission_fee, render: amount },
            { label: 'service_fee', value: order.service_fee, render: amount },
            { label: 'transaction_fee', value: order.transaction_fee, render: amount, optional: true },
          ]}
        />

        <div className="fee-section-title">정산</div>
        <FeeRows rows={[{ label: 'escrow_amount', value: order.escrow_amount, render: amount }]} />

        <div className="fee-section-title">배송</div>
        <FeeRows
          rows={[
            { label: 'shipping_carrier', value: order.shipping_carrier || order.checkout_shipping_carrier },
            { label: 'tracking_number', value: order.tracking_number },
          ]}
        />

        <div className="fee-section-title">주문 아이템</div>
        <div className="fee-items">
          {items.length ? (
            items.map((item, index) => {
              const price = item.model_discounted_price || item.model_original_price;
              return (
                <div className="fee-item" key={`${item.item_id || index}-${item.model_id || index}`}>
                  <p><strong>상품명:</strong> {display(item.item_name)}</p>
                  <p><strong>옵션명:</strong> {display(item.model_name)}</p>
                  <p><strong>수량:</strong> {display(item.model_quantity_purchased)}</p>
                  <p><strong>단가:</strong> {isPresent(price) ? `${Number(price).toFixed(2)} ${currency}` : '-'}</p>
                </div>
              );
            })
          ) : (
            <p>주문 아이템 정보가 없습니다.</p>
          )}
        </div>
      </div>
    </div>
  );
}
