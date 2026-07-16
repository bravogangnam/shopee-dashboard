import { useEffect, useMemo, useState } from 'react';
import { fetchOrderDetail } from '../api/orders.js';
import { formatKrw } from '../utils/format.js';

function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
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

function numeric(value) {
  if (!isPresent(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
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
  return symbols[String(currency || '').toUpperCase()] || `${currency || ''} `;
}

function formatMoney(value, currency, negative = false) {
  const number = numeric(value);
  if (number === null) return '-';

  const absolute = Math.abs(number);
  const sign = negative && absolute !== 0 ? '-' : number < 0 ? '-' : '';
  return `${sign}${currencySymbol(currency)}${absolute.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatRate(value, currency) {
  const number = numeric(value);
  if (number === null || number === 0) return '-';
  return `1 ${currency || ''} = ₩${number.toLocaleString('ko-KR')}`;
}

function statusClass(status) {
  return `status-pill status-${String(status || '').toLowerCase()}`;
}

function regionClass(region) {
  return `region-badge region-${String(region || '').toLowerCase()}`;
}

function getItemImageUrl(item) {
  return (
    item?.image_info_image_url ||
    item?.item_image_url ||
    item?.image_url ||
    item?.image ||
    ''
  );
}

function getUnitPrice(item) {
  return numeric(item?.model_discounted_price) ?? numeric(item?.model_original_price);
}

function getQuantity(item) {
  return numeric(item?.model_quantity_purchased);
}

function getSku(item) {
  return item?.model_sku || item?.item_sku || '-';
}

function DetailRows({ rows, currency, tone = '' }) {
  return (
    <div className={`order-settlement-detail-rows ${tone ? `tone-${tone}` : ''}`}>
      {rows.map(row => (
        <div
          className={`order-settlement-detail-row ${row.strong ? 'strong' : ''}`}
          key={row.label}
        >
          <span>{row.label}</span>
          <strong>
            {row.krw
              ? formatKrw(row.value)
              : formatMoney(row.value, currency, row.negative)}
          </strong>
        </div>
      ))}
    </div>
  );
}

function formatPercent(value) {
  const number = numeric(value);
  if (number === null) return '-';
  return `${number.toLocaleString('ko-KR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function formatWeight(value) {
  const number = numeric(value);
  if (number === null || number <= 0) return null;
  return `${Math.round(number).toLocaleString('ko-KR')}g`;
}

function returnStatusLabel(status) {
  const labels = {
    REQUESTED: '요청됨',
    ACCEPTED: '승인됨',
    CANCELLED: '취소됨',
    JUDGING: '심사 중',
    CLOSED: '종료됨',
    PROCESSING: '처리 중',
    SELLER_DISPUTE: '판매자 분쟁',
  };

  return labels[status] || status || '-';
}

function returnReasonLabel(reason) {
  const labels = {
    NONE: '사유 없음',
    NOT_RECEIPT: '상품 미수령',
    NON_RECEIPT: '상품 미수령',
    WRONG_ITEM: '잘못된 상품',
    ITEM_DAMAGED: '상품 파손',
    DAMAGED_OTHERS: '상품 파손',
    DIFFERENT_DESCRIPTION: '상품 설명과 다름',
    MUTUAL_AGREE: '상호 합의',
    OTHER: '기타',
    ITEM_WRONGDAMAGED: '오배송 또는 파손',
    CHANGE_MIND: '단순 변심',
    CHANGE_OF_MIND: '단순 변심',
    ITEM_MISSING: '상품 누락',
    EXPECTATION_FAILED: '기대와 다름',
    ITEM_FAKE: '가품 의심',
    PHYSICAL_DMG: '외관 손상',
    FUNCTIONAL_DMG: '기능 이상',
  };

  return labels[reason] || reason || '-';
}

function returnSolutionLabel(solution) {
  const labels = {
    RETURN_REFUND: '반품 후 환불',
    REFUND: '반품 없는 환불',
    1: '반품 후 환불',
    2: '환불',
  };

  return labels[solution] || solution || '-';
}

function negotiationStatusLabel(status) {
  const labels = {
    PENDING_RESPOND: '판매자 응답 대기',
    PENDING_BUYER_RESPOND: '구매자 응답 대기',
    TERMINATED: '협상 종료',
  };

  return labels[status] || status || '-';
}

function formatReturnDate(value) {
  const number = numeric(value);
  if (number === null || number <= 0) return '-';

  return new Date(number * 1000).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function returnStatusClass(status) {
  return `order-return-status order-return-status-${String(status || '').toLowerCase()}`;
}

export default function OrderSettlementDetailModal({ orderSn, shopId, onClose }) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    setOrder(null);
    setLoading(true);
    setError('');

    fetchOrderDetail(orderSn, shopId)
      .then(result => {
        if (cancelled) return;
        setOrder(result?.data || result || null);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err?.message || '주문 상세를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      setOrder(null);
      setError('');
    };
  }, [orderSn, shopId]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const items = Array.isArray(order?.item_list) ? order.item_list : [];
  const returnRefunds = Array.isArray(order?.return_refunds)
    ? order.return_refunds
    : order?.latest_return_refund
      ? [order.latest_return_refund]
      : [];
  const currency = order?.currency || order?.region || '';

  const feeValues = useMemo(() => {
    const values = [
      numeric(order?.commission_fee),
      numeric(order?.service_fee),
      numeric(order?.transaction_fee),
    ];

    if (values.every(value => value === null)) return null;
    return values.reduce((sum, value) => sum + (value ?? 0), 0);
  }, [order]);

  const shippingFeePaidByBuyer =
    order?.shipping_fee ?? order?.actual_shipping_fee ?? null;

  const logisticProviderShippingFee =
    order?.actual_shipping_fee ?? order?.shipping_fee ?? null;

  const salesKrw = useMemo(() => {
    const sales = numeric(order?.merchandise_subtotal ?? order?.total_amount);
    const rate = numeric(order?.krw_rate);
    if (sales === null || rate === null || sales * rate === 0) return null;
    return sales * rate;
  }, [order]);

  const profitRate = useMemo(() => {
    const profit = numeric(order?.net_profit);
    if (profit === null || salesKrw === null) return null;
    return (profit / salesKrw) * 100;
  }, [order, salesKrw]);

  const productProfitRate = useMemo(() => {
    const profit = numeric(order?.product_profit);
    if (profit === null || salesKrw === null) return null;
    return (profit / salesKrw) * 100;
  }, [order, salesKrw]);

  const chargeableWeight = formatWeight(
    order?.order_chargeable_weight_gram
    ?? order?.chargeable_weight_gram
    ?? order?.chargeable_weight
  );

  return (
    <div className="modal-overlay order-settlement-overlay" onClick={onClose}>
      <div
        className="modal-content order-settlement-modal"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`주문 정산 상세 ${orderSn}`}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="주문 상세 닫기"
        >
          ✕
        </button>

        <div className="order-settlement-title">
          <div>
            <h2>Payment Information</h2>
            <p>Order ID: {orderSn}</p>
          </div>
        </div>

        {loading && (
          <div className="order-settlement-state">주문 상세 불러오는 중...</div>
        )}

        {!loading && error && (
          <div className="order-settlement-state error">
            <p>{error}</p>
            <button type="button" className="ghost-button" onClick={onClose}>
              닫기
            </button>
          </div>
        )}

        {!loading && !error && order && (
          <>
            <div className="order-settlement-meta">
              <div>
                <span>Order ID</span>
                <strong>{order.order_sn || orderSn}</strong>
              </div>
              <div>
                <span>Shop</span>
                <strong>
                  <span className={regionClass(order.region)}>
                    {order.region || order.shop_alias || order.shop_id || '-'}
                  </span>
                </strong>
              </div>
              <div>
                <span>Order Status</span>
                <strong>
                  <span className={statusClass(order.display_status || order.order_status)}>
                    {orderStatusLabel(order.display_status || order.order_status)}
                  </span>
                </strong>
              </div>
              <div>
                <span>Buyer ID</span>
                <strong className="order-settlement-buyer-id">
                  {order.buyer_username || order.buyer_user_id || '-'}
                </strong>
              </div>
              <div>
                <span>Currency</span>
                <strong>{currency || '-'}</strong>
              </div>
              <div>
                <span>환율</span>
                <strong>{formatRate(order.krw_rate, currency)}</strong>
              </div>
            </div>

            <section className="order-settlement-section">
              <h3>Products</h3>
              <div className="order-settlement-product-table-wrap">
                <table className="order-settlement-product-table">
                  <colgroup>
                    <col className="col-no" />
                    <col className="col-product" />
                    <col className="col-price" />
                    <col className="col-quantity" />
                    <col className="col-subtotal" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>No.</th>
                      <th>Product(s)</th>
                      <th>Unit Price</th>
                      <th>Quantity</th>
                      <th>Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length ? (
                      items.map((item, index) => {
                        const unitPrice = getUnitPrice(item);
                        const quantity = getQuantity(item);
                        const subtotal =
                          unitPrice !== null && quantity !== null
                            ? unitPrice * quantity
                            : null;

                        return (
                          <tr key={`${item.item_id || index}-${item.model_id || index}`}>
                            <td>{index + 1}</td>
                            <td>
                              <div className="order-settlement-product-cell">
                                {getItemImageUrl(item) ? (
                                  <img
                                    className="order-settlement-product-thumb"
                                    src={getItemImageUrl(item)}
                                    alt=""
                                    loading="lazy"
                                  />
                                ) : null}

                                <div className="order-settlement-product-info">
                                  <strong>{item.item_name || '-'}</strong>
                                  <small>Variation: {item.model_name || '-'}</small>
                                  <small>SKU: {getSku(item)}</small>
                                </div>
                              </div>
                            </td>
                            <td>{formatMoney(unitPrice, currency)}</td>
                            <td>{quantity ?? '-'}</td>
                            <td>{formatMoney(subtotal, currency)}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan="5">주문 상품 정보가 없습니다.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {returnRefunds.length > 0 && (
              <section className="order-settlement-return-section">
                <div className="order-settlement-return-heading">
                  <div>
                    <span className="order-settlement-return-icon">↩</span>
                    <div>
                      <h3>반품/환불</h3>
                      <p>
                        이 주문에 연결된 반품·환불 요청 {returnRefunds.length}건
                      </p>
                    </div>
                  </div>

                  <span className="order-settlement-return-count">
                    {returnRefunds.length}건
                  </span>
                </div>

                <div className="order-settlement-return-list">
                  {returnRefunds.map((returnItem, index) => {
                    const returnCurrency =
                      returnItem.currency || currency;

                    return (
                      <article
                        className="order-settlement-return-card"
                        key={
                          returnItem.return_sn ||
                          `${returnItem.order_sn || orderSn}-${index}`
                        }
                      >
                        <div className="order-settlement-return-card-head">
                          <div>
                            <span>Return SN</span>
                            <strong>
                              {returnItem.return_sn || '-'}
                            </strong>
                          </div>

                          <span
                            className={returnStatusClass(
                              returnItem.return_status
                            )}
                          >
                            {returnStatusLabel(
                              returnItem.return_status
                            )}
                          </span>
                        </div>

                        <div className="order-settlement-return-grid">
                          <div>
                            <span>사유</span>
                            <strong>
                              {returnReasonLabel(
                                returnItem.return_reason
                              )}
                            </strong>
                            {returnItem.text_reason ? (
                              <small>{returnItem.text_reason}</small>
                            ) : null}
                          </div>

                          <div>
                            <span>환불 금액</span>
                            <strong>
                              {formatMoney(
                                returnItem.refund_amount,
                                returnCurrency
                              )}
                            </strong>
                          </div>

                          <div>
                            <span>처리 방식</span>
                            <strong>
                              {returnSolutionLabel(
                                returnItem.return_refund_type ||
                                returnItem.return_solution
                              )}
                            </strong>
                          </div>

                          <div>
                            <span>협상 상태</span>
                            <strong>
                              {negotiationStatusLabel(
                                returnItem.negotiation_status
                              )}
                            </strong>
                          </div>

                          <div>
                            <span>요청일</span>
                            <strong>
                              {formatReturnDate(
                                returnItem.create_time
                              )}
                            </strong>
                          </div>

                          <div>
                            <span>최종 업데이트</span>
                            <strong>
                              {formatReturnDate(
                                returnItem.update_time
                              )}
                            </strong>
                          </div>
                        </div>

                        {returnItem.reverse_logistics_status ||
                        returnItem.tracking_number ? (
                          <div className="order-settlement-return-logistics">
                            {returnItem.reverse_logistics_status ? (
                              <span>
                                반품 배송 상태
                                <strong>
                                  {returnItem.reverse_logistics_status}
                                </strong>
                              </span>
                            ) : null}

                            {returnItem.tracking_number ? (
                              <span>
                                반품 운송장
                                <strong>
                                  {returnItem.tracking_number}
                                </strong>
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            <div className="order-settlement-finance-grid">
              <section className="order-settlement-finance-card income">
                <h3>
                  <span className="order-settlement-section-icon">▣</span>
                  Income Details
                </h3>
                <DetailRows
                  currency={currency}
                  tone="income"
                  rows={[
                    { label: 'Merchandise Subtotal', value: order.merchandise_subtotal },
                    { label: 'Estimated Shipping Subtotal', value: shippingFeePaidByBuyer },
                    { label: 'Shipping Fee Paid by Buyer', value: shippingFeePaidByBuyer },
                    {
                      label: 'Estimated Shipping Fee Charged by Logistic Provider',
                      value: logisticProviderShippingFee,
                    },
                    { label: 'Vouchers & Rebates', value: order.voucher_from_seller, negative: true },
                    { label: 'Fees & Charges', value: feeValues, negative: true },
                    {
                      label: 'Estimated Order Income',
                      value: order.escrow_amount,
                      strong: true,
                    },
                  ]}
                />
              </section>

              <section className="order-settlement-finance-card fees">
                <h3>
                  <span className="order-settlement-section-icon">▣</span>
                  Fees & Charges Details
                </h3>
                <DetailRows
                  currency={currency}
                  tone="fees"
                  rows={[
                    { label: 'Commission Fee', value: order.commission_fee, negative: true },
                    { label: 'Service Fee', value: order.service_fee, negative: true },
                    { label: 'Transaction Fee', value: order.transaction_fee, negative: true },
                    {
                      label: 'Total Fees & Charges',
                      value: feeValues,
                      negative: true,
                      strong: true,
                    },
                  ]}
                />
              </section>

              <section className="order-settlement-finance-card buyer">
                <h3>
                  <span className="order-settlement-section-icon">▣</span>
                  Buyer Payment
                </h3>
                <DetailRows
                  currency={currency}
                  tone="buyer"
                  rows={[
                    { label: 'Merchandise Subtotal', value: order.merchandise_subtotal },
                    { label: 'Shipping Fee', value: order.shipping_fee },
                    { label: 'Shopee Voucher', value: order.voucher_from_shopee, negative: true },
                    { label: 'Seller Voucher', value: order.voucher_from_seller, negative: true },
                    {
                      label: 'Total Buyer Payment',
                      value: order.buyer_total_amount,
                      strong: true,
                    },
                  ]}
                />
              </section>
            </div>

            <section className="order-settlement-total-bar">
              <div>
                <span className="order-settlement-total-icon">▣</span>
                <strong>Total Buyer Payment</strong>
              </div>
              <strong>{formatMoney(order.buyer_total_amount, currency)}</strong>
            </section>

            <section className="order-settlement-internal">
              <h3>
                <span className="order-settlement-internal-icon">▣</span>
                내부 정산 정보
              </h3>

              <div className={`order-settlement-internal-grid ${chargeableWeight ? 'has-weight' : ''}`}>
                <div className="order-settlement-internal-card weight">
                  <span>과금 무게</span>
                  <strong>{chargeableWeight ?? '-'}</strong>
                  <small>
                    {chargeableWeight
                      ? '배송 확정 무게'
                      : '배송 처리 후 표시'}
                  </small>
                </div>

                <div className="order-settlement-internal-card">
                  <span>실제 원가</span>
                  <strong>{formatKrw(order.total_cost_price)}</strong>
                </div>

                <div className="order-settlement-internal-card">
                  <span>부가세</span>
                  <strong>{formatKrw(order.total_vat)}</strong>
                </div>

                <div className="order-settlement-internal-card profit">
                  <span>순이익</span>
                  <strong>{formatKrw(order.net_profit)}</strong>
                  <small>순이익률 {formatPercent(profitRate)}</small>
                </div>

                <div className="order-settlement-internal-card product-profit">
                  <span>제품 순이익</span>
                  <strong>{formatKrw(order.product_profit)}</strong>
                  <small>제품 순이익률 {formatPercent(productProfitRate)}</small>
                </div>
              </div>
            </section>

            <div className="order-settlement-actions">
              <button type="button" className="ghost-button" onClick={onClose}>
                닫기
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
