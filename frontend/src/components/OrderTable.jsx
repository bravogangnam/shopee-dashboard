import MarginBadge from './MarginBadge.jsx';
import { formatCurrency, formatDateTime, formatKrw, profitTone } from '../utils/format.js';

export default function OrderTable({ orders, loading }) {
  if (loading) {
    return <div className="table-state">주문을 불러오는 중...</div>;
  }

  if (!orders.length) {
    return <div className="table-state">조회된 주문이 없습니다.</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Order ID</th>
            <th>Shop</th>
            <th>Status</th>
            <th>상품명</th>
            <th>옵션명</th>
            <th className="num">수량</th>
            <th className="num">판매가</th>
            <th className="num">정산금액</th>
            <th className="num">실제원가 합계</th>
            <th className="num">할인원가 합계</th>
            <th className="num">순이익</th>
            <th className="num">상품이익</th>
            <th>마진상태</th>
          </tr>
        </thead>
        <tbody>
          {orders.map(order => {
            const firstItem = order.item_list?.[0] || {};
            const quantity = order.item_list?.reduce((sum, item) => {
              const count = Number(item.model_quantity_purchased || 0);
              return sum + (Number.isFinite(count) ? count : 0);
            }, 0) || firstItem.model_quantity_purchased || '-';

            return (
              <tr key={`${order.shop_id}-${order.order_sn}`}>
                <td>
                  <strong>{order.order_sn}</strong>
                  <small>{formatDateTime(order.order_created_at)}</small>
                </td>
                <td>
                  <span className="shop-pill">{order.shop_alias || order.region || order.shop_id}</span>
                </td>
                <td><span className="status-pill">{order.order_status}</span></td>
                <td className="truncate" title={firstItem.item_name || ''}>{firstItem.item_name || '-'}</td>
                <td className="truncate" title={firstItem.model_name || ''}>{firstItem.model_name || '-'}</td>
                <td className="num">{quantity}</td>
                <td className="num">{formatCurrency(order.merchandise_subtotal, order.currency)}</td>
                <td className="num">{formatCurrency(order.escrow_amount, order.currency)}</td>
                <td className="num">{formatKrw(order.total_cost_price)}</td>
                <td className="num">{formatKrw(order.total_discounted_price)}</td>
                <td className={`num ${profitTone(order.net_profit)}`}>{formatKrw(order.net_profit)}</td>
                <td className={`num ${profitTone(order.product_profit)}`}>{formatKrw(order.product_profit)}</td>
                <td><MarginBadge status={order.margin_status} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
