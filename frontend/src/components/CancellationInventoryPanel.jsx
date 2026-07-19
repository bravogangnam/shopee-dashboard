import { useEffect, useMemo, useState } from 'react';
import { fetchCancellationInventoryReviews, restoreCancellationInventory } from '../api/products.js';
import CopyIconButton from './CopyIconButton.jsx';

const labels = {
  AUTO_RESTORED: '자동 복원 완료',
  RESTORE_PENDING: '복원 대기',
  DO_NOT_RESTORE: '복원 제외',
  RESTORED_MANUALLY: '복원 완료',
};

export default function CancellationInventoryPanel({ onMessage, onError }) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState(null);
  const [restoring, setRestoring] = useState(false);

  async function load() {
    setLoading(true);
    try { setRows(await fetchCancellationInventoryReviews(filter)); }
    catch (error) { onError?.(error.message || '취소 재고 이력을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [filter]);
  const counts = useMemo(() => rows.reduce((acc, row) => ({ ...acc, [row.decision]: (acc[row.decision] || 0) + 1 }), {}), [rows]);
  async function restore() {
    if (!target) return;
    setRestoring(true);
    try {
      await restoreCancellationInventory(target.shop_id, target.order_sn);
      setTarget(null); onMessage?.('취소 주문 재고를 복원했습니다.'); await load();
    } catch (error) { onError?.(error.message || '재고 복원에 실패했습니다.'); }
    finally { setRestoring(false); }
  }
  return <section className="cancellation-inventory-panel">
    <div className="cancellation-inventory-heading"><div><h2>취소 재고 추적</h2><p>정책 적용 이후 취소 주문만 기록합니다.</p></div></div>
    <div className="cancellation-inventory-summary">
      {['AUTO_RESTORED','RESTORE_PENDING','DO_NOT_RESTORE'].map(key => <button key={key} type="button" className={`cancellation-summary-card ${filter === key ? 'active' : ''}`} onClick={() => setFilter(filter === key ? '' : key)}><span>{labels[key]}</span><strong>{counts[key] || 0}건</strong></button>)}
    </div>
    {loading ? <div className="table-state">취소 재고 이력을 불러오는 중...</div> : <div className="table-wrap inventory-table-wrap"><table className="data-table cancellation-inventory-table"><thead><tr><th>취소일시</th><th>주문번호</th><th>샵</th><th>상품 / SKU</th><th className="num">수량</th><th>직전 단계</th><th>처리 상태</th><th>사유</th><th>작업</th></tr></thead><tbody>{rows.length ? rows.map(row => <tr key={`${row.shop_id}-${row.order_sn}`}><td>{String(row.created_at || '-').replace('T',' ').replace('.000Z','')}</td><td><div className="order-id-row"><strong>{row.order_sn}</strong><CopyIconButton value={row.order_sn} label="주문번호" /></div></td><td><span className={`region-badge region-${String(row.region || '').toLowerCase()}`}>{row.region || '-'}</span></td><td><strong>{row.item_names || '-'}</strong><small>{row.skus || '-'}</small></td><td className="num">{Number(row.total_quantity || 0)}</td><td>{row.previous_order_status}</td><td><span className={`cancellation-decision ${row.decision.toLowerCase()}`}>{labels[row.decision] || row.decision}</span></td><td>{row.decision_reason}</td><td>{row.decision === 'RESTORE_PENDING' && <button type="button" className="invoice-btn" onClick={() => setTarget(row)}>재고 복원</button>}</td></tr>) : <tr><td colSpan="9" className="empty-cell">표시할 취소 재고 이력이 없습니다.</td></tr>}</tbody></table></div>}
    {target && <div className="modal-backdrop"><div className="modal cancellation-restore-modal"><div className="modal-header"><div><h2>재고를 복원할까요?</h2><p>실물 회수가 확인된 경우에만 복원하세요.</p></div><button type="button" onClick={() => setTarget(null)}>×</button></div><div className="modal-body"><p><strong>주문번호:</strong> {target.order_sn}</p><p><strong>상품:</strong> {target.item_names || '-'}</p><p><strong>SKU:</strong> {target.skus || '-'}</p><p><strong>복원 수량:</strong> {target.total_quantity || 0}개</p><p>FIFO 재고와 현재 재고가 함께 증가하며, 같은 주문에는 한 번만 실행할 수 있습니다.</p></div><div className="modal-footer"><button type="button" className="ghost-button" disabled={restoring} onClick={() => setTarget(null)}>취소</button><button type="button" className="action-btn primary" disabled={restoring} onClick={restore}>{restoring ? '복원 중...' : '재고 복원'}</button></div></div></div>}
  </section>;
}
