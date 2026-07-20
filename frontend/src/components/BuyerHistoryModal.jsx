import { useState } from 'react';
import OrderSettlementDetailModal from './OrderSettlementDetailModal.jsx';

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currencySymbol(currency) {
  const symbols = {
    PHP: '₱',
    MYR: 'RM',
    SGD: 'S$',
    TWD: 'NT$',
    THB: '฿',
    VND: '₫',
    BRL: 'R$',
    MXN: 'MX$',
  };

  return (
    symbols[String(currency || '').toUpperCase()] ||
    `${currency || ''} `
  );
}

function formatMoney(value, currency) {
  return `${currencySymbol(currency)}${numeric(value).toLocaleString(
    'en-US',
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  )}`;
}

function formatKrw(value) {
  return `₩${Math.round(numeric(value)).toLocaleString('ko-KR')}`;
}

function formatOrderDate(value) {
  if (!value) return '-';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function orderStatusLabel(status) {
  const labels = {
    UNPAID: '결제 대기',
    PENDING: '펜딩',
    READY_TO_SHIP: '송장준비',
    PROCESSED: '발송처리',
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

function statusClass(status) {
  return `status-pill status-${String(status || '').toLowerCase()}`;
}

function returnRefundLabel(order) {
  if (!order?.has_return_refund) {
    return '없음';
  }

  const status = String(order.return_status || '').toUpperCase();

  const completeWords = [
    'COMPLETED',
    'COMPLETE',
    'CLOSED',
    'REFUNDED',
    'REFUND_PAID',
    'RETURN_COMPLETED',
  ];

  if (completeWords.some(word => status.includes(word))) {
    return '반품/환불 완료';
  }

  return '반품/환불 진행 중';
}

export default function BuyerHistoryModal({
  history,
  loading,
  error,
  currentOrderSn,
  onClose,
}) {
  const [selectedOrder, setSelectedOrder] = useState(null);

  return (
    <>
      {!selectedOrder && <div
        className="modal-overlay buyer-history-overlay"
        onClick={event => {
          event.stopPropagation();
          onClose();
        }}
      >
        <div
          className="modal-content buyer-history-modal"
          onClick={event => event.stopPropagation()}
        >
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="닫기"
          >
            ×
          </button>

          <header className="buyer-history-header">
            <h2>구매자 구매이력</h2>

            <p>
              <strong>{history?.buyer_username || '-'}</strong>

              {history?.buyer_user_id
                ? ` · ${history.buyer_user_id}`
                : ''}
            </p>
          </header>

          {loading && (
            <div className="buyer-history-message">
              구매이력을 불러오는 중입니다.
            </div>
          )}

          {!loading && error && (
            <div className="buyer-history-message buyer-history-error">
              {error}
            </div>
          )}

          {!loading && !error && history && (
            <>
              <div className="buyer-history-summary">
                <div>
                  <span>총 주문</span>

                  <strong>
                    {history.total_orders || 0}건
                    <small>
                      {formatKrw(
                        history.total_orders_amount_krw
                      )}
                    </small>
                  </strong>
                </div>

                <div>
                  <span>완료</span>

                  <strong>
                    {history.completed_orders || 0}건
                    <small>
                      {formatKrw(
                        history.completed_orders_amount_krw
                      )}
                    </small>
                  </strong>
                </div>

                <div>
                  <span>취소</span>

                  <strong>
                    {history.cancelled_orders || 0}건
                    <small>
                      {formatKrw(
                        history.cancelled_orders_amount_krw
                      )}
                    </small>
                  </strong>
                </div>
              </div>

              {history.current_purchase_number === 1 && (
                <div className="buyer-history-purchase-number">
                  현재 주문은 <strong>첫 구매</strong>
                </div>
              )}

              {history.current_purchase_number > 1 && (
                <div className="buyer-history-purchase-number">
                  현재 주문은{' '}
                  <strong>
                    {history.current_purchase_number}번째 구매
                  </strong>
                </div>
              )}

              <div className="buyer-history-table-wrap">
                <table className="buyer-history-table">
                  <thead>
                    <tr>
                      <th>주문일</th>
                      <th>주문번호</th>
                      <th>Shop</th>
                      <th>주문상태</th>
                      <th>상품명</th>
                      <th>주문금액</th>
                      <th>Return / Refund</th>
                    </tr>
                  </thead>

                  <tbody>
                    {history.orders?.length ? (
                      history.orders.map(order => {
                        const displayStatus =
                          order.display_status ||
                          order.order_status;

                        return (
                          <tr
                            key={`${order.shop_id}-${order.order_sn}`}
                            className={
                              order.order_sn === currentOrderSn
                                ? 'buyer-history-current-row'
                                : ''
                            }
                          >
                            <td>
                              {formatOrderDate(
                                order.order_created_at ||
                                  order.create_time
                              )}
                            </td>

                            <td>
                              <button
                                type="button"
                                className="buyer-history-order-link"
                                onClick={() =>
                                  setSelectedOrder(order)
                                }
                              >
                                {order.order_sn}
                              </button>

                              {order.order_sn === currentOrderSn && (
                                <span className="buyer-history-current-badge">
                                  현재 주문
                                </span>
                              )}
                            </td>

                            <td>
                              {order.shop_alias ||
                                order.region ||
                                order.shop_id ||
                                '-'}
                            </td>

                            <td>
                              <span
                                className={statusClass(
                                  displayStatus
                                )}
                              >
                                {orderStatusLabel(
                                  displayStatus
                                )}
                              </span>
                            </td>

                            <td className="buyer-history-products">
                              {order.product_names || '-'}
                            </td>

                            <td className="buyer-history-order-amount">
                              {formatMoney(
                                order.order_amount,
                                order.currency
                              )}
                            </td>

                            <td>
                              <span
                                className={
                                  order.has_return_refund
                                    ? 'buyer-history-return active'
                                    : 'buyer-history-return'
                                }
                              >
                                {returnRefundLabel(order)}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td
                          className="buyer-history-empty"
                          colSpan="7"
                        >
                          구매이력이 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>}

      {selectedOrder && (
        <OrderSettlementDetailModal
          orderSn={selectedOrder.order_sn}
          shopId={selectedOrder.shop_id}
          onClose={onClose}
        />
      )}
    </>
  );
}
