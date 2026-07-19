import CopyIconButton from './CopyIconButton.jsx';
import MarginBadge from './MarginBadge.jsx';
import { formatCurrency, formatDateTime, formatKrw, profitTone } from '../utils/format.js';

function calculateMarginRate(order) {
  const hasSales = order.merchandise_subtotal !== null && order.merchandise_subtotal !== undefined;
  const hasProfit = order.net_profit !== null && order.net_profit !== undefined;
  const hasRate = order.krw_rate !== null && order.krw_rate !== undefined;
  if (!hasSales || !hasProfit || !hasRate) return '-';

  const salesKrw = Number(order.merchandise_subtotal) * Number(order.krw_rate);
  const netProfit = Number(order.net_profit);
  if (!Number.isFinite(salesKrw) || !Number.isFinite(netProfit) || salesKrw === 0) return '-';

  return `${((netProfit / salesKrw) * 100).toFixed(2)}%`;
}

function regionClass(region) {
  return `region-badge region-${String(region || '').toLowerCase()}`;
}

function statusClass(status) {
  return `status-pill status-${String(status || '').toLowerCase()}`;
}


function calculateProductNetProfit(order) {
  const netProfit = Number(order?.net_profit || 0);
  const vatRefund = Number(order?.total_vat || 0);
  return netProfit - vatRefund;
}

function calculateProductProfitRate(order) {
  const salesAmount = Number(order?.merchandise_subtotal || order?.total_amount || 0);
  const krwRate = Number(order?.krw_rate || 0);
  const salesKrw = salesAmount * krwRate;

  if (!salesKrw) return '-';

  const rate = (calculateProductNetProfit(order) / salesKrw) * 100;
  return `${rate.toFixed(2)}%`;
}

function getDisplayStatus(order) {
  return order?.display_status || order?.order_status;
}

function isCancelledOrder(order) {
  return (order?.display_status || order?.order_status) === 'CANCELLED';
}

export default function OrderTable({ orders, loading, onOrderDetail }) {
  if (loading) {
    return <div className="table-state">주문을 불러오는 중...</div>;
  }

  if (!orders.length) {
    return <div className="table-state">조회된 주문이 없습니다.</div>;
  }

  return (
    <div className="table-wrap ledger-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Order ID</th>
            <th>SKU</th>
            <th>Shop</th>
            <th>Status</th>
            <th>상품명</th>
            <th>옵션명</th>
            <th className="num">수량</th>
            <th className="num">무게(g)</th>
            <th className="num">판매가</th>
            <th className="num">정산금액</th>
            <th className="num">실제원가</th>
            <th className="num"><span className="tooltip-header">순이익<span className="tooltip-icon" data-tooltip="부가세 환급까지 포함해서 최종적으로 남는 돈">?</span></span></th>
            <th className="num"><span className="tooltip-header">부가세 환급액<span className="tooltip-icon" data-tooltip="상품을 구매할 때 먼저 냈지만 나중에 돌려받는 부가세">?</span></span></th>
            <th className="num"><span className="tooltip-header">제품순이익<span className="tooltip-icon" data-tooltip="부가세 환급액을 빼고 봤을 때 상품 자체로 남는 돈">?</span></span></th>
            <th className="num"><span className="tooltip-header">순이익률<span className="tooltip-icon" data-tooltip="판매가 대비 최종 순이익 비율">?</span></span></th>
            <th className="num"><span className="tooltip-header">제품순이익률<span className="tooltip-icon" data-tooltip="판매가 대비 제품순이익 비율">?</span></span></th>
            <th>확정상태</th>
          </tr>
        </thead>
        <tbody>
          {orders.map(order => {
            const items = Array.isArray(order.item_list) ? order.item_list : [];
            const quantity = items.reduce((sum, item) => {
              const count = Number(item.model_quantity_purchased || 0);
              return sum + (Number.isFinite(count) ? count : 0);
            }, 0) || '-';
            const region = order.region || order.shop_alias || order.shop_id;

            const renderItemLines = (field, className) => {
              if (!items.length) return '-';
              return items.map((item, index) => (
                <div
                  key={`${field}-${item.item_id || index}-${item.model_id || ''}`}
                  className={`item-line ${className}`}
                  title={item[field] || ''}
                >
                  {item[field] || '-'}
                </div>
              ));
            };

            const renderProductLines = () => {
              if (!items.length) return '-';
              return items.map((item, index) => (
                <button
                  type="button"
                  key={`product-${item.item_id || index}-${item.model_id || ''}`}
                  className="item-line truncate order-product-detail-button"
                  title={item.item_name || ''}
                  aria-label={`${order.order_sn} ${item.item_name || '상품'} 주문 정산 상세 보기`}
                  onClick={() => onOrderDetail(order)}
                >
                  {item.item_name || '-'}
                </button>
              ));
            };

            const renderSkuLines = () => {
              if (!items.length) return '-';
              return items.map((item, index) => {
                const sku = item.model_sku || item.item_sku || '-';
                return (
                  <div
                    key={`sku-${item.item_id || index}-${item.model_id || ''}`}
                    className="item-line ledger-sku-line"
                  >
                    <span>{sku}</span>
                    {sku !== '-' && <CopyIconButton value={sku} label="SKU" />}
                  </div>
                );
              });
            };

            const renderQuantityLines = () => {
              if (!items.length) return quantity;
              return items.map((item, index) => (
                <div
                  key={`qty-${item.item_id || index}-${item.model_id || ''}`}
                  className="item-line"
                >
                  {item.model_quantity_purchased ?? '-'}
                </div>
              ));
            };

            return (
              <tr key={`${order.shop_id}-${order.order_sn}`} className={isCancelledOrder(order) ? 'cancelled-row' : ''}>
                <td>
                  <div className="order-id-row">
                    <strong className="order-id-text">{order.order_sn}</strong>
                    <CopyIconButton
                      value={order.order_sn}
                      label="주문번호"
                    />
                  </div>
                  <small>{formatDateTime(order.order_created_at)}</small>
                </td>
                <td>{renderSkuLines()}</td>
                <td>
                  <span className={regionClass(order.region)}>{region}</span>
                </td>
                <td><span className={statusClass(getDisplayStatus(order))}>{getDisplayStatus(order)}</span></td>
                <td>{renderProductLines()}</td>
                <td>{renderItemLines('model_name', 'truncate-short')}</td>
                <td className="num">{renderQuantityLines()}</td>
                <td className="num">{order.order_chargeable_weight_gram ?? "-"}</td>
                <td className="num">{formatCurrency(order.merchandise_subtotal, order.currency)}</td>
                <td className="num">{formatCurrency(order.escrow_amount, order.currency)}</td>
                <td className="num">{formatKrw(order.total_cost_price)}</td>
                <td className={`num ${profitTone(order.net_profit)}`}>{formatKrw(order.net_profit)}</td>
                <td className="num">{formatKrw(order.total_vat)}</td>
                <td className={`num ${profitTone(calculateProductNetProfit(order))}`}>{formatKrw(calculateProductNetProfit(order))}</td>
                <td className={`num ${profitTone(order.net_profit)}`}>{calculateMarginRate(order)}</td>
                <td className={`num ${profitTone(calculateProductNetProfit(order))}`}>{calculateProductProfitRate(order)}</td>
                <td>
                  <span
                    className={`margin-status-badge ${
                      Number(order.order_chargeable_weight_gram || 0) > 0 &&
                      ["확정", "confirmed", "CONFIRMED"].includes(String(order.margin_status || "").trim())
                        ? "confirmed"
                        : "pending"
                    }`}
                  >
                    <span className="margin-status-dot" />
                    {Number(order.order_chargeable_weight_gram || 0) > 0 &&
                    ["확정", "confirmed", "CONFIRMED"].includes(String(order.margin_status || "").trim())
                      ? "확정"
                      : "미확정"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
