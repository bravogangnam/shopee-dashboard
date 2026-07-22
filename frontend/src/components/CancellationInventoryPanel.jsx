import { useEffect, useMemo, useState } from 'react';
import { fetchCancellationInventoryReviews, restoreCancellationInventory } from '../api/products.js';
import CopyIconButton from './CopyIconButton.jsx';
import OrderSettlementDetailModal from './OrderSettlementDetailModal.jsx';

const labels = {
  AUTO_RESTORED: '자동 복원 완료',
  RESTORE_PENDING: '복원 확인 필요',
  DO_NOT_RESTORE: '복원 대상 아님',
  RESTORED_MANUALLY: '수동 복원 완료',
};

const previousStatusLabels = {
  UNPAID: '결제 대기',
  PENDING: '주문 대기',
  READY_TO_SHIP: '송장 준비',
  PROCESSED: '발송 처리',
  SHIPPED: '배송 중',
  TO_CONFIRM_RECEIVE: '수취 확인',
  COMPLETED: '배송 완료',
  CANCELLED: '취소 완료',
  UNKNOWN: '최초 확인 시 이미 취소',
};

function getDecisionReason(row) {
  const status = row.previous_order_status;
  if (status === 'UNPAID' || status === 'PENDING') {
    return '재고 차감 전 취소 · 복원할 재고 없음';
  }
  if (status === 'READY_TO_SHIP') {
    return '재고 차감 후·출고 접수 전 취소 · 자동 복원';
  }
  if (status === 'PROCESSED') {
    return '출고 접수 후 취소 · 실제 회수 확인 필요';
  }
  if (['SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED'].includes(status)) {
    return '배송 진행 이후 취소 · 자동 복원 제외';
  }
  return row.decision_reason || '재고 차감 이력 확인 불가 · 자동 복원 제외';
}

function getPreviousStatus(status) {
  const label = previousStatusLabels[status];
  return label ? `${label} (${status})` : status || '-';
}

function getItems(row) {
  if (Array.isArray(row.items) && row.items.length) return row.items;
  return [{
    id: 'legacy',
    sku: row.skus || '',
    item_name: row.item_names || '',
    option_name: row.option_names || '',
    quantity: Number(row.total_quantity || 0),
  }];
}

export default function CancellationInventoryPanel({ onMessage, onError }) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState(null);
  const [detailOrder, setDetailOrder] = useState(null);
  const [restoring, setRestoring] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setRows(await fetchCancellationInventoryReviews(''));
    } catch (error) {
      onError?.(error.message || '취소 재고 이력을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const counts = useMemo(
    () => rows.reduce((acc, row) => ({ ...acc, [row.decision]: (acc[row.decision] || 0) + 1 }), {}),
    [rows]
  );
  const visibleRows = useMemo(
    () => (filter ? rows.filter(row => row.decision === filter) : rows),
    [filter, rows]
  );

  async function restore() {
    if (!target) return;
    setRestoring(true);
    try {
      await restoreCancellationInventory(target.shop_id, target.order_sn);
      setTarget(null);
      onMessage?.('취소 주문 재고를 복원했습니다.');
      await load();
    } catch (error) {
      onError?.(error.message || '재고 복원에 실패했습니다.');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section className="cancellation-inventory-panel">
      <div className="cancellation-inventory-heading">
        <div>
          <h2>취소 재고 추적</h2>
          <p>취소 직전 단계와 실제 재고 차감 여부를 기준으로 복원 상태를 표시합니다.</p>
        </div>
      </div>

      <div className="cancellation-inventory-summary">
        {['AUTO_RESTORED', 'RESTORE_PENDING', 'DO_NOT_RESTORE'].map(key => (
          <button
            key={key}
            type="button"
            className={`cancellation-summary-card ${filter === key ? 'active' : ''}`}
            onClick={() => setFilter(filter === key ? '' : key)}
          >
            <span>{labels[key]}</span>
            <strong>{counts[key] || 0}건</strong>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="table-state">취소 재고 이력을 불러오는 중...</div>
      ) : (
        <div className="table-wrap inventory-table-wrap">
          <table className="data-table cancellation-inventory-table">
            <thead>
              <tr>
                <th>취소일시</th>
                <th>주문번호</th>
                <th>샵</th>
                <th>SKU</th>
                <th>상품명</th>
                <th>옵션명</th>
                <th className="num">수량</th>
                <th>취소 직전 단계</th>
                <th>재고 처리</th>
                <th>처리 기준</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length ? visibleRows.map(row => {
                const items = getItems(row);
                return (
                <tr key={`${row.shop_id}-${row.order_sn}`}>
                  <td>{String(row.created_at || '-').replace('T', ' ').replace('.000Z', '')}</td>
                  <td>
                    <div className="order-id-row">
                      <button
                        type="button"
                        className="link-button cancellation-order-link"
                        onClick={() => setDetailOrder({ orderSn: row.order_sn, shopId: row.shop_id })}
                      >
                        {row.order_sn}
                      </button>
                      <CopyIconButton value={row.order_sn} label="주문번호" />
                    </div>
                  </td>
                  <td><span className={`region-badge region-${String(row.region || '').toLowerCase()}`}>{row.region || '-'}</span></td>
                  <td>
                    <div className="cancellation-item-lines">
                      {items.map(item => <div className="ledger-sku-line" key={item.id}>
                        <span>{item.sku || '-'}</span>
                        {item.sku && <CopyIconButton value={item.sku} label="SKU" />}
                      </div>)}
                    </div>
                  </td>
                  <td><div className="cancellation-item-lines">{items.map(item => <div key={item.id}>{item.item_name || '-'}</div>)}</div></td>
                  <td><div className="cancellation-item-lines">{items.map(item => <div key={item.id}>{item.option_name || '-'}</div>)}</div></td>
                  <td className="num"><div className="cancellation-item-lines">{items.map(item => <div key={item.id}>{Number(item.quantity || 0)}</div>)}</div></td>
                  <td>{getPreviousStatus(row.previous_order_status)}</td>
                  <td><span className={`cancellation-decision ${row.decision.toLowerCase()}`}>{labels[row.decision] || row.decision}</span></td>
                  <td>{getDecisionReason(row)}</td>
                  <td>{row.decision === 'RESTORE_PENDING' && <button type="button" className="invoice-btn" onClick={() => setTarget(row)}>재고 복원</button>}</td>
                </tr>
              )}) : (
                <tr><td colSpan="11" className="empty-cell">표시할 취소 재고 이력이 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {target && (
        <div className="modal-backdrop">
          <div className="modal cancellation-restore-modal">
            <div className="modal-header">
              <div>
                <h2>재고를 복원할까요?</h2>
                <p>실물 회수가 확인된 경우에만 복원하세요.</p>
              </div>
              <button type="button" onClick={() => setTarget(null)}>×</button>
            </div>
            <div className="modal-body">
              <p><strong>주문번호:</strong> {target.order_sn}</p>
              <p><strong>대상 상품:</strong> {getItems(target).length}개 항목</p>
              <p><strong>복원 수량:</strong> {target.total_quantity || 0}개</p>
              <p>FIFO 재고와 현재 재고가 함께 증가하며, 같은 주문에는 한 번만 실행할 수 있습니다.</p>
            </div>
            <div className="modal-footer">
              <button type="button" className="ghost-button" disabled={restoring} onClick={() => setTarget(null)}>취소</button>
              <button type="button" className="action-btn primary" disabled={restoring} onClick={restore}>{restoring ? '복원 중...' : '재고 복원'}</button>
            </div>
          </div>
        </div>
      )}
      {detailOrder && (
        <OrderSettlementDetailModal
          orderSn={detailOrder.orderSn}
          shopId={detailOrder.shopId}
          onClose={() => setDetailOrder(null)}
        />
      )}
    </section>
  );
}
