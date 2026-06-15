import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  adjustProductStartBalance,
  fetchInventoryMovements,
  fetchInventoryProducts,
  fetchTodayOrderInventory,
  syncInventoryReceipts,
  updateProductStock,
} from '../api/products.js';
import ImagePreviewModal from '../components/ImagePreviewModal.jsx';

function formatDateTime(value) {
  if (!value) return '-';
  return String(value).replace('T', ' ').replace('.000Z', '');
}

function formatDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value).replace(' ', 'T').slice(0, 16);
  }
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toMysqlDateTime(value) {
  return value ? `${value.replace('T', ' ')}:00` : null;
}

function nowKSTDateTimeLocal() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 16);
}

function getProductName(product) {
  return product.product_name_kr || product.product_name || product.item_name || product.product_name_en || '-';
}

function getStockStatus(product) {
  const stock = Number(product.stock_quantity || 0);
  const threshold = Number(product.low_stock_threshold || 0);
  if (stock < 0) return { key: 'purchase_needed', label: '구매필요' };
  if (stock === 0) return { key: 'out_of_stock', label: '품절' };
  if (stock > 0 && stock <= threshold) return { key: 'low_stock', label: '재고부족' };
  return { key: 'in_stock', label: '재고보유' };
}

function movementLabel(type) {
  if (type === 'SALE') return '판매 차감';
  if (type === 'CANCEL_RESTORE') return '취소 복구';
  if (type === 'MANUAL_ADJUST') return '재고 조정';
  return type || '-';
}

function movementTone(movement) {
  const qty = Number(movement.qty_delta || 0);
  if (movement.movement_type === 'SALE' || qty < 0) return 'negative';
  if (qty > 0) return 'positive';
  return '';
}

function formatKrw(value) {
  return `₩${Math.round(Number(value || 0)).toLocaleString('ko-KR')}`;
}

function formatWon(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '-';
  return `₩${Math.round(number).toLocaleString('ko-KR')}`;
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function copySkuToClipboard(sku) {
  const text = String(sku || '').trim();
  if (!text) return;

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    return;
  }

  fallbackCopyText(text);
}

function SkuCopyCell({ sku }) {
  return (
    <div className="sku-copy-cell">
      <strong>{sku}</strong>
      <button
        type="button"
        className="copy-sku-btn"
        onClick={() => copySkuToClipboard(sku)}
        title="SKU 복사"
      >
        복사
      </button>
    </div>
  );
}

function InventoryStats({ products, summary }) {
  const fallbackSummary = {
    purchase_needed_sku_count: products.filter(product => Number(product.stock_quantity || 0) < 0).length,
    out_of_stock_count: products.filter(product => Number(product.stock_quantity || 0) === 0).length,
    low_stock_count: products.filter(product => {
      const stockQty = Number(product.stock_quantity || 0);
      const threshold = Number(product.low_stock_threshold || 0);
      return stockQty > 0 && stockQty <= threshold;
    }).length,
    in_stock_sku_count: products.filter(product => Number(product.stock_quantity || 0) > 0).length,
    total_inventory_value: 0,
  };
  const stats = summary || fallbackSummary;

  const cards = [
    {
      label: '구매필요 SKU',
      value: `${Number(stats.purchase_needed_sku_count || 0).toLocaleString('ko-KR')}개`,
      sub: '주문 대비 부족',
      tone: 'inventory-card-purchase-needed',
    },
    {
      label: '품절 SKU',
      value: `${Number(stats.out_of_stock_count || 0).toLocaleString('ko-KR')}개`,
      sub: '재고 0',
      tone: 'inventory-card-out',
    },
    {
      label: '재고부족 SKU',
      value: `${Number(stats.low_stock_count || 0).toLocaleString('ko-KR')}개`,
      sub: '부족 기준 이하',
      tone: 'inventory-card-low',
    },
    {
      label: '보유 재고 SKU',
      value: `${Number(stats.in_stock_sku_count || 0).toLocaleString('ko-KR')}개`,
      sub: '재고 보유 중',
      tone: 'inventory-card-in-stock',
    },
    {
      label: '총 재고액',
      value: formatKrw(stats.total_inventory_value),
      sub: 'VAT 포함 / FIFO 잔량 기준',
      tone: 'inventory-card-value',
    },
  ];

  return (
    <div className="inventory-stats">
      {cards.map(card => (
        <div className={`inventory-stat-card ${card.tone}`} key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.sub}</small>
        </div>
      ))}
    </div>
  );
}

function SyncDetailList({ title, items }) {
  if (!items?.length) return null;
  const visibleItems = items.slice(0, 20);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <div className="receipt-sync-detail">
      <strong>{title}</strong>
      <ul>
        {visibleItems.map((item, index) => (
          <li key={`${title}-${index}`}>
            {[
              item.sheet_row ? `row ${item.sheet_row}` : null,
              item.receipt_id ? `receipt ${item.receipt_id}` : null,
              item.source_sku ? `source ${item.source_sku}` : null,
              item.sku ? `sku ${item.sku}` : null,
              item.reason || '-',
            ].filter(Boolean).join(' / ')}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && <p>외 {hiddenCount.toLocaleString('ko-KR')}건</p>}
    </div>
  );
}

function ReceiptSyncResultCard({ result }) {
  if (!result) return null;

  const metrics = [
    ['처리 성공', result.processed, '건'],
    ['입고 batch 생성', result.inserted_batches, '건'],
    ['재고 증가 합계', result.stock_added, '개'],
    ['스킵', result.skipped, '건'],
    ['오류', result.errors, '건'],
    ['상품구성표 갱신', result.sku_compositions_upserted, '건'],
    ['상품구성표 오류', result.sku_compositions_errors, '건'],
    ['시트 상태 변경', result.sheet_status_updated, '건'],
    ['시트 상태 변경 실패', result.sheet_status_update_failed, '건'],
    ['시트 상태 skipped', result.sheet_status_update_skipped, '건'],
  ];

  return (
    <div className="receipt-sync-result">
      <div className="receipt-sync-result-header">
        <h2>입고관리 동기화 결과</h2>
        <span>{new Date().toLocaleTimeString('ko-KR')}</span>
      </div>
      <div className="receipt-sync-metrics">
        {metrics.map(([label, value, unit]) => (
          <div className="receipt-sync-metric" key={label}>
            <span>{label}</span>
            <strong>{Number(value || 0).toLocaleString('ko-KR')}{unit}</strong>
          </div>
        ))}
      </div>
      {Number(result.sheet_status_update_skipped || 0) > 0 && (
        <div className="receipt-sync-warning">
          구글시트 상태 자동 변경은 현재 비활성화되어 있습니다. 성공한 행은 시트에서 수동으로 동기화완료 처리하세요.
        </div>
      )}
      <SyncDetailList title="오류 상세" items={result.error_details || []} />
      <SyncDetailList title="유효하지 않은 행" items={result.invalid_rows || []} />
      <SyncDetailList title="중복 스킵" items={result.duplicate_details || []} />
    </div>
  );
}

function uniqReceiptDetails(items = []) {
  const map = new Map();
  for (const item of items) {
    const receiptId = item.receipt_id || item.receiptId || '';
    const key = `${item.sheet_row || ''}:${receiptId}:${item.source_sku || ''}:${item.reason || ''}`;
    if (!map.has(key)) map.set(key, { ...item, receipt_id: receiptId });
  }
  return Array.from(map.values());
}

function formatReceiptLine(item, includeReason = false) {
  return [
    item.sheet_row ? `row ${item.sheet_row}` : null,
    item.receipt_id || '-',
    includeReason ? item.reason || '-' : null,
  ].filter(Boolean).join(' / ');
}

function buildReceiptReminder(result) {
  const completed = uniqReceiptDetails(result?.processed_details || result?.success_details || []);
  const duplicates = uniqReceiptDetails(result?.duplicate_details || []);
  const errors = uniqReceiptDetails([
    ...(result?.error_details || []),
    ...(result?.invalid_rows || []),
  ]);

  return {
    completed,
    duplicates,
    errors,
    hasAny: completed.length > 0 || duplicates.length > 0 || errors.length > 0,
  };
}

function ReceiptSyncReminderModal({ result, onClose }) {
  const [copyMessage, setCopyMessage] = useState('');
  const reminder = useMemo(() => buildReceiptReminder(result), [result]);

  if (!reminder.hasAny) return null;

  const completedIds = reminder.completed
    .map(item => item.receipt_id)
    .filter(Boolean);
  const duplicateIds = reminder.duplicates
    .map(item => item.receipt_id)
    .filter(Boolean);

  async function handleCopy() {
    const text = [
      '동기화완료 처리 필요:',
      ...(completedIds.length ? completedIds : ['-']),
      '',
      '이미 동기화됨:',
      ...(duplicateIds.length ? duplicateIds : ['-']),
    ].join('\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage('입고ID 목록을 복사했습니다.');
    } catch (err) {
      setCopyMessage('복사에 실패했습니다. 목록을 직접 선택해서 복사하세요.');
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card receipt-sync-reminder-modal">
        <div className="modal-header">
          <div>
            <h2>구글시트 상태 변경 필요</h2>
            <p>아래 입고ID는 DB 동기화가 완료되었습니다.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>닫기</button>
        </div>

        <div className="receipt-sync-reminder-alert">
          구글시트 입고관리 탭에서 해당 행의 상태를 반드시 <strong>동기화완료</strong>로 변경하세요.
        </div>

        <div className="receipt-sync-reminder-section">
          <h3>동기화완료로 변경할 입고ID</h3>
          {reminder.completed.length ? (
            <ul>
              {reminder.completed.map((item, index) => (
                <li key={`completed-${index}`}>{formatReceiptLine(item)}</li>
              ))}
            </ul>
          ) : (
            <p>새로 성공 처리된 입고ID가 없습니다.</p>
          )}
        </div>

        <div className="receipt-sync-reminder-section">
          <h3>이미 동기화된 입고ID</h3>
          {reminder.duplicates.length ? (
            <ul>
              {reminder.duplicates.map((item, index) => (
                <li key={`duplicate-${index}`}>{formatReceiptLine(item)}</li>
              ))}
            </ul>
          ) : (
            <p>중복으로 확인된 입고ID가 없습니다.</p>
          )}
        </div>

        {reminder.errors.length > 0 && (
          <div className="receipt-sync-reminder-section receipt-sync-reminder-error">
            <h3>수정 필요</h3>
            <p>아래 항목은 오류로 처리되지 않았습니다. 수정 후 다시 대기 상태로 동기화하세요.</p>
            <ul>
              {reminder.errors.map((item, index) => (
                <li key={`error-${index}`}>{formatReceiptLine(item, true)}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="modal-actions">
          {copyMessage && <span className="receipt-sync-copy-message">{copyMessage}</span>}
          <button type="button" className="action-btn" onClick={handleCopy}>입고ID 목록 복사</button>
          <button type="button" className="action-btn primary" onClick={onClose}>확인했습니다</button>
        </div>
      </div>
    </div>
  );
}

function OrderLinesModal({ item, onClose }) {
  if (!item) return null;

  function goToOrder(orderSn) {
    window.location.href = `/orders?order_sn=${encodeURIComponent(orderSn)}`;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card today-order-lines-modal">
        <div className="modal-header">
          <div>
            <h2>관련 주문번호</h2>
            <p>{item.sku}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>닫기</button>
        </div>
        <ul className="today-order-lines-list">
          {(item.order_lines || []).map(line => (
            <li key={line.order_sn}>
              <button type="button" onClick={() => goToOrder(line.order_sn)}>
                {line.order_sn}
              </button>
              <span>수량 {Number(line.qty || 0).toLocaleString('ko-KR')}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TodayOrderInventoryTable({
  items,
  purchaseOnly,
  onPreviewImage,
  onShowOrders,
  onAdjustStock,
  onOpenHistory,
}) {
  function goToOrder(orderSn) {
    window.location.href = `/orders?order_sn=${encodeURIComponent(orderSn)}`;
  }

  return (
    <div className="today-order-inventory">
      <div className="today-order-toolbar">
        <div>
          <strong>오늘 주문 상품 재고 현황</strong>
          <p>오늘 주문수량과 30일 판매을 함께 표시합니다.</p>
        </div>
      </div>

      {items.length ? (
        <div className="table-wrap today-order-table-wrap">
          <table className="data-table today-order-inventory-table">
            <thead>
                <tr>
                  <th className="today-col-sku">SKU</th>
                  <th className="num today-col-cost">부가세포함 원가</th>
                  <th className="num today-col-qty">오늘 주문수량</th>
                  <th className="num today-col-stock">현재 재고</th>
                  <th className="num today-col-needed">구매필요</th>
                    <th className="num today-col-qty">30일판매</th>
                  <th className="today-col-name">상품명</th>
                  <th className="today-col-order">주문번호</th>
                  <th className="today-col-status">상태</th>
                  <th className="today-col-actions">작업</th>
                </tr>
              </thead>
            <tbody>
              {items.map(item => {
                const orderLines = item.order_lines || [];
                const firstOrder = orderLines[0]?.order_sn || item.order_sns?.[0] || '';
                const productName = getProductName(item);
                const status = getStockStatus(item);
                const purchaseNeeded = Number(item.purchase_needed_qty || 0);
                const hasImage = Boolean(item.image_url);

                return (
                  <tr key={item.sku}>
                      <td className="today-col-sku-cell"><SkuCopyCell sku={item.sku} /></td>
                      <td className="num today-col-cost">{formatWon(item.latest_unit_cost_vat)}</td>
                      <td className="num today-col-qty">{Number(item.ordered_qty || 0).toLocaleString('ko-KR')}</td>
                      <td className={`num today-col-stock ${Number(item.stock_quantity || 0) < 0 ? 'negative' : ''}`}>
                        {Number(item.stock_quantity || 0).toLocaleString('ko-KR')}
                      </td>
                      <td className={`num today-col-needed purchase-needed-qty ${purchaseNeeded > 0 ? 'active' : ''}`}>
                        {purchaseNeeded.toLocaleString('ko-KR')}
                      </td>
                        <td className="num today-col-qty">{Number(item.recent_30d_sold_qty || 0).toLocaleString('ko-KR')}</td>
                      <td className="today-col-name">
                        <button
                          type="button"
                          className={`link-button inventory-product-link ${hasImage ? '' : 'disabled'}`}
                          onClick={() => hasImage && onPreviewImage({
                            image_url: item.image_url,
                            item_name: productName,
                            model_name: item.sku,
                          })}
                          disabled={!hasImage}
                          title={productName}
                        >
                          {productName}
                        </button>
                        {item.product_name_en && <small>{item.product_name_en}</small>}
                      </td>
                        <td className="today-col-order">
                          {orderLines.length <= 1 ? (
                            <button type="button" className="link-button" onClick={() => firstOrder && goToOrder(firstOrder)}>
                              {firstOrder || '-'}
                            </button>
                          ) : (
                            <button type="button" className="link-button" onClick={() => onShowOrders(item)}>
                              {firstOrder} 외 {orderLines.length - 1}건
                            </button>
                          )}
                        </td>
                      <td className="today-col-status">
                        <span className={`stock-status-pill stock-status-${status.key}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="today-col-actions">
                        <div className="inventory-actions">
                          <button type="button" className="invoice-btn" onClick={() => onAdjustStock(item)}>
                            재고 보정
                          </button>
                          <button type="button" className="invoice-btn" onClick={() => onOpenHistory(item)}>
                            이력보기
                          </button>
                        </div>
                      </td>
                    </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-state">
          {purchaseOnly ? '구매필요 SKU가 없습니다.' : '표시할 SKU가 없습니다.'}
        </div>
      )}
    </div>
  );
}

function StockSettingsModal({ product, saving, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    stock_quantity: product.stock_quantity ?? 0,
    low_stock_threshold: product.low_stock_threshold ?? 3,
    stock_tracking_started_at: formatDateTimeLocal(product.stock_tracking_started_at) || nowKSTDateTimeLocal(),
  }));

  function setField(field, value) {
    setForm(current => ({ ...current, [field]: value }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    onSave({
      stock_quantity: Number.parseInt(form.stock_quantity, 10),
      low_stock_threshold: Number.parseInt(form.low_stock_threshold, 10),
      stock_tracking_started_at: toMysqlDateTime(form.stock_tracking_started_at),
    });
  }

  return (
    <div className="modal-backdrop">
      <form className="modal-card inventory-modal" onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <h2>재고 기준 설정</h2>
            <p>{product.sku}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>닫기</button>
        </div>

        <div className="inventory-help-text">
          현재 재고 수량은 입고관리탭/FIFO 반영 후 관리하는 것을 권장합니다.
          이 설정은 부족 기준과 추적 시작일 같은 재고 관리 기준을 조정하는 용도입니다.
          현재 재고 직접 수정은 파손, 분실, 실사 차이 같은 예외 상황에서만 사용하세요.
        </div>

        <label>
          현재 재고
          <input
            type="number"
            step="1"
            value={form.stock_quantity}
            onChange={event => setField('stock_quantity', event.target.value)}
          />
        </label>
        <label>
          부족 기준
          <input
            type="number"
            step="1"
            min="0"
            value={form.low_stock_threshold}
            onChange={event => setField('low_stock_threshold', event.target.value)}
          />
        </label>
        <label>
          추적 시작일
          <input
            type="datetime-local"
            value={form.stock_tracking_started_at}
            onChange={event => setField('stock_tracking_started_at', event.target.value)}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>취소</button>
          <button type="submit" disabled={saving}>기준 저장</button>
        </div>
      </form>
    </div>
  );
}

function StockAdjustModal({ product, saving, onClose, onSave }) {
  const currentStock = Number(product.stock_quantity || 0);
  const [targetStockQuantity, setTargetStockQuantity] = useState(String(currentStock));
  const [note, setNote] = useState('');
  const parsedTarget = Number.parseInt(targetStockQuantity, 10);
  const isValidTarget = Number.isInteger(parsedTarget) && parsedTarget >= 0;
  const isSameTarget = isValidTarget && parsedTarget === currentStock;
  const isIncreaseTarget = isValidTarget && parsedTarget > currentStock;
  const canSubmit = isValidTarget && parsedTarget < currentStock && !saving;

  function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    onSave({ target_stock_quantity: parsedTarget, note });
  }

  return (
    <div className="modal-backdrop">
      <form className="modal-card inventory-modal" onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <h2>재고 보정</h2>
            <p>{product.sku}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>닫기</button>
        </div>

        <div className="inventory-help-text">
          파손/분실/실사 차이로 재고를 줄일 때 사용합니다.
          재고 증가는 입고관리탭에 입력 후 입고관리 동기화로 처리하세요.
          이 보정은 products 재고와 FIFO batch 잔량을 함께 줄입니다.
        </div>

        <div className="stock-adjust-current">
          현재 재고: <strong>{currentStock.toLocaleString('ko-KR')}</strong>
        </div>

        <label>
          실제 재고 수량
          <input
            type="number"
            step="1"
            min="0"
            max={currentStock}
            value={targetStockQuantity}
            onChange={event => setTargetStockQuantity(event.target.value)}
            placeholder="현재 실사 재고 수량"
          />
        </label>
        {!isValidTarget && (
          <div className="field-warning">0 이상의 정수를 입력하세요.</div>
        )}
        {isSameTarget && (
          <div className="field-warning">현재 재고와 동일합니다. 보정할 차감 수량이 없습니다.</div>
        )}
        {isIncreaseTarget && (
          <div className="field-warning">
            현재 재고보다 큰 값은 입력할 수 없습니다. 추가 입고는 입고관리탭에서 처리하세요.
          </div>
        )}
        <label>
          메모
          <input
            value={note}
            onChange={event => setNote(event.target.value)}
            placeholder="단위 입력 오류 보정"
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>취소</button>
          <button type="submit" disabled={!canSubmit}>
            저장
          </button>
        </div>
      </form>
    </div>
  );
}

function MovementsModal({ product, movements, loading, onClose }) {
  return (
    <div className="modal-backdrop">
      <div className="modal-card inventory-history-modal">
        <div className="modal-header">
          <div>
            <h2>재고 이력</h2>
            <p>{product.sku}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>닫기</button>
        </div>

        {loading ? (
          <div className="table-state">이력을 불러오는 중...</div>
        ) : (
          <div className="table-wrap inventory-history-wrap">
            <table className="data-table inventory-history-table">
              <thead>
                <tr>
                  <th>생성일</th>
                  <th>유형</th>
                  <th className="num">변동 수량</th>
                  <th>주문번호</th>
                  <th>메모</th>
                </tr>
              </thead>
              <tbody>
                {movements.length ? movements.map(movement => (
                  <tr key={movement.id}>
                    <td>{formatDateTime(movement.created_at)}</td>
                    <td>
                      <span className={`movement-pill movement-${String(movement.movement_type || '').toLowerCase()}`}>
                        {movementLabel(movement.movement_type)}
                      </span>
                    </td>
                    <td className={`num ${movementTone(movement)}`}>
                      {Number(movement.qty_delta || 0) > 0 ? '+' : ''}{movement.qty_delta}
                    </td>
                    <td>{movement.order_sn || '-'}</td>
                    <td>{movement.note || '-'}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan="5" className="empty-cell">재고 이력이 없습니다.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}


const inventoryPageCache = {
  products: [],
  inventorySummary: null,
  todayOrderItems: [],
  todayOrderSummary: null,
  activeInventoryTab: 'today',
  todayPurchaseOnly: true,
  search: '',
  statusFilter: 'ALL',
  allSkuPage: 1,
  refreshedAt: null,
  loaded: false,
};

const ALL_SKU_PAGE_SIZE = 20;

export default function InventoryPage() {
  const [products, setProducts] = useState(() => inventoryPageCache.products || []);
  const [inventorySummary, setInventorySummary] = useState(() => inventoryPageCache.inventorySummary || null);
  const [todayOrderItems, setTodayOrderItems] = useState(() => inventoryPageCache.todayOrderItems || []);
  const [todayOrderSummary, setTodayOrderSummary] = useState(() => inventoryPageCache.todayOrderSummary || null);
  const [activeInventoryTab, setActiveInventoryTab] = useState(() => inventoryPageCache.activeInventoryTab || 'today');
  const [todayPurchaseOnly, setTodayPurchaseOnly] = useState(() => inventoryPageCache.todayPurchaseOnly ?? true);
  const [search, setSearch] = useState(() => inventoryPageCache.search || '');
  const [statusFilter, setStatusFilter] = useState(() => inventoryPageCache.statusFilter || 'ALL');
  const [allSkuPage, setAllSkuPage] = useState(() => inventoryPageCache.allSkuPage || 1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [receiptReminderResult, setReceiptReminderResult] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(() => inventoryPageCache.refreshedAt || null);
  const [settingsProduct, setSettingsProduct] = useState(null);
  const [adjustProduct, setAdjustProduct] = useState(null);
  const [historyProduct, setHistoryProduct] = useState(null);
  const [todayOrderLinesProduct, setTodayOrderLinesProduct] = useState(null);
  const [inventoryPreviewItem, setInventoryPreviewItem] = useState(null);
  const [movements, setMovements] = useState([]);
  const [movementsLoading, setMovementsLoading] = useState(false);

  const filteredProducts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return products.filter(product => {
      const stockQty = Number(product.stock_quantity || 0);
      const threshold = Number(product.low_stock_threshold || 0);
      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'purchase_needed' && stockQty < 0) ||
        (statusFilter === 'in_stock' && stockQty > 0) ||
        (statusFilter === 'low_stock' && stockQty > 0 && stockQty <= threshold) ||
        (statusFilter === 'out_of_stock' && stockQty === 0);
      const haystack = [
        product.sku || '',
        getProductName(product),
        product.product_name_en || '',
        product.product_name_kr || '',
        product.option_name || '',
        (product.order_sns || []).join(' '),
        product.order_sn || '',
      ].join(' ').toLowerCase();
      const matchesKeyword = !keyword || haystack.includes(keyword);
      return matchesStatus && matchesKeyword;
    });
  }, [products, search, statusFilter]);

  const allSkuTotalPages = Math.max(1, Math.ceil(filteredProducts.length / ALL_SKU_PAGE_SIZE));

  const paginatedProducts = useMemo(() => {
    const safePage = Math.min(Math.max(1, allSkuPage), allSkuTotalPages);
    const startIndex = (safePage - 1) * ALL_SKU_PAGE_SIZE;
    return filteredProducts.slice(startIndex, startIndex + ALL_SKU_PAGE_SIZE);
  }, [filteredProducts, allSkuPage, allSkuTotalPages]);

  const filteredTodayOrderItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return todayOrderItems.filter(item => {
      if (todayPurchaseOnly && Number(item.stock_quantity || 0) >= 0) return false;
      const haystack = `${item.sku || ''} ${getProductName(item)} ${item.product_name_en || ''} ${(item.order_sns || []).join(' ')}`.toLowerCase();
      return !keyword || haystack.includes(keyword);
    });
  }, [todayOrderItems, todayPurchaseOnly, search]);

  const autoRefreshPaused = loading ||
    syncLoading ||
    saving ||
    Boolean(settingsProduct) ||
    Boolean(adjustProduct) ||
    Boolean(historyProduct) ||
    Boolean(receiptReminderResult) ||
    Boolean(todayOrderLinesProduct) ||
    Boolean(inventoryPreviewItem);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [inventoryResult, todayResult] = await Promise.all([
        fetchInventoryProducts(),
        fetchTodayOrderInventory(),
      ]);
      const nextProducts = inventoryResult.data || [];
      const nextInventorySummary = inventoryResult.summary || null;
      const nextTodayOrderItems = todayResult.data || [];
      const nextTodayOrderSummary = todayResult.summary || null;
      const nextRefreshedAt = new Date();

      setProducts(nextProducts);
      setInventorySummary(nextInventorySummary);
      setTodayOrderItems(nextTodayOrderItems);
      setTodayOrderSummary(nextTodayOrderSummary);
      setRefreshedAt(nextRefreshedAt);

      inventoryPageCache.products = nextProducts;
      inventoryPageCache.inventorySummary = nextInventorySummary;
      inventoryPageCache.todayOrderItems = nextTodayOrderItems;
      inventoryPageCache.todayOrderSummary = nextTodayOrderSummary;
      inventoryPageCache.refreshedAt = nextRefreshedAt;
      inventoryPageCache.loaded = true;
    } catch (err) {
      setError(err.message || '재고 목록을 불러오지 못했습니다.');
      setProducts([]);
      setInventorySummary(null);
      setTodayOrderItems([]);
      setTodayOrderSummary(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (inventoryPageCache.loaded) return;
    loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    inventoryPageCache.activeInventoryTab = activeInventoryTab;
  }, [activeInventoryTab]);

  useEffect(() => {
    inventoryPageCache.todayPurchaseOnly = todayPurchaseOnly;
  }, [todayPurchaseOnly]);

  useEffect(() => {
    inventoryPageCache.search = search;
  }, [search]);

  useEffect(() => {
    inventoryPageCache.statusFilter = statusFilter;
  }, [statusFilter]);

  useEffect(() => {
    inventoryPageCache.allSkuPage = allSkuPage;
  }, [allSkuPage]);

  useEffect(() => {
    setAllSkuPage(1);
  }, [search, activeInventoryTab, statusFilter]);

  function handleInventoryFilterReset() {
    setSearch('');
    if (activeInventoryTab === 'all') {
      setStatusFilter('ALL');
    }
    setAllSkuPage(1);
  }

  useEffect(() => {
    if (allSkuPage > allSkuTotalPages) {
      setAllSkuPage(allSkuTotalPages);
    }
  }, [allSkuPage, allSkuTotalPages]);



  async function handleSaveSettings(payload) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await updateProductStock(settingsProduct.sku, payload);
      setMessage('재고 기준을 저장했습니다.');
      setSettingsProduct(null);
      await loadProducts();
    } catch (err) {
      setError(err.message || '재고 기준 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }

  async function handleAdjustStock(payload) {
    if (!Number.isInteger(payload.target_stock_quantity) || payload.target_stock_quantity < 0) {
      setError('실제 재고 수량은 0 이상의 정수여야 합니다.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await adjustProductStartBalance(adjustProduct.sku, payload);
      const result = response.result || {};
      const adjustedQtyText = result.adjusted_qty
        ? ` 차감 수량: ${Number(result.adjusted_qty).toLocaleString('ko-KR')}개`
        : '';
      setMessage(`재고 보정이 완료되었습니다.${adjustedQtyText}`);
      setAdjustProduct(null);
      await loadProducts();
      if (historyProduct?.sku === adjustProduct.sku) {
        await openHistory(adjustProduct);
      }
    } catch (err) {
      setError(err.message || '재고 보정에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(product) {
    setHistoryProduct(product);
    setMovements([]);
    setMovementsLoading(true);
    setError('');
    try {
      const result = await fetchInventoryMovements(product.sku, 50);
      setMovements(result);
    } catch (err) {
      setError(err.message || '재고 이력을 불러오지 못했습니다.');
    } finally {
      setMovementsLoading(false);
    }
  }

  async function handleReceiptSync() {
    setSyncLoading(true);
    setError('');
    setMessage('');
    setSyncResult(null);
    setReceiptReminderResult(null);
    try {
      const response = await syncInventoryReceipts();
      const result = response.result || response;
      setSyncResult(result);
      if (buildReceiptReminder(result).hasAny) {
        setReceiptReminderResult(result);
      }
      setMessage('입고관리 동기화가 완료되었습니다. 성공한 행은 구글시트에서 수동으로 동기화완료 처리하세요.');
      await loadProducts();
    } catch (err) {
      setError(`입고관리 동기화에 실패했습니다: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setSyncLoading(false);
    }
  }

  return (
    <section className="page inventory-page">
      <div className="page-header">
        <div>
          <h1>재고 관리</h1>
          <p>
            재고 수량은 대시보드 입고 관리 메뉴에서 반영합니다.
            재고 증가는 입고 관리에서 처리하고, 재고 보정은 파손/분실/실사 차이처럼 재고를 줄일 때만 사용합니다.
            Shopee 실제 재고와는 연동하지 않습니다.
          </p>
        </div>
        <div className="action-buttons">
          <button type="button" className="action-btn" onClick={loadProducts} disabled={loading}>
            {loading ? '새로고침 중' : '새로고침'}
          </button>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="alert">{error}</div>}

      <div className="receipt-sync-panel receipt-sync-disabled">
        <div>
          <strong>입고관리 시트 동기화 중단</strong>
          <p>
            입고관리 시트와 상품구성표 시트 동기화는 중단되었습니다.
            앞으로 입고 등록과 상품구성표 관리는 왼쪽 메뉴의 입고 관리에서 처리하세요.
          </p>
        </div>
      </div>

      <ReceiptSyncResultCard result={syncResult} />

      <InventoryStats products={products} summary={inventorySummary} />
      <div className="inventory-refresh-note">
        마지막 갱신: {refreshedAt ? refreshedAt.toLocaleTimeString('ko-KR') : '-'}
      </div>

      <div className="inventory-tabs">
        <button
          type="button"
          className={activeInventoryTab === 'today' ? 'active' : ''}
          onClick={() => setActiveInventoryTab('today')}
        >
          오늘 주문 상품
          {todayOrderSummary && <span>{Number(todayOrderSummary.sku_count || 0).toLocaleString('ko-KR')}</span>}
        </button>
        <button
          type="button"
          className={activeInventoryTab === 'all' ? 'active' : ''}
          onClick={() => setActiveInventoryTab('all')}
        >
          전체 SKU
          <span>{products.length.toLocaleString('ko-KR')}</span>
        </button>
      </div>

      <div className="inventory-filters">
        <label className="filter-field order-search-field">
          SKU / 상품명 / 주문번호
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="SKU / 상품명 / Order SN"
          />
        </label>
        {activeInventoryTab === 'all' && (
          <label className="filter-field">
            상태
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="ALL">전체</option>
              <option value="purchase_needed">구매필요</option>
              <option value="out_of_stock">품절</option>
              <option value="low_stock">재고부족</option>
              <option value="in_stock">재고보유</option>
            </select>
          </label>
        )}
        <div className="filter-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={handleInventoryFilterReset}
          >
            초기화
          </button>
          <button
            type="button"
            className={`action-btn ${
              (activeInventoryTab === 'today' && todayPurchaseOnly) ||
              (activeInventoryTab === 'all' && statusFilter === 'purchase_needed')
                ? 'primary'
                : ''
            }`}
            onClick={() => {
              if (activeInventoryTab === 'today') {
                setTodayPurchaseOnly(current => !current);
                return;
              }
              setStatusFilter(current => (current === 'purchase_needed' ? 'ALL' : 'purchase_needed'));
            }}
          >
            구매필요만 보기
          </button>
        </div>
      </div>

      {loading ? (
        <div className="table-state">재고 목록을 불러오는 중...</div>
      ) : activeInventoryTab === 'today' ? (
        <TodayOrderInventoryTable
          items={filteredTodayOrderItems}
          purchaseOnly={todayPurchaseOnly}
          onPreviewImage={setInventoryPreviewItem}
          onShowOrders={setTodayOrderLinesProduct}
          onAdjustStock={setAdjustProduct}
          onOpenHistory={openHistory}
        />
      ) : filteredProducts.length ? (
        <div className="table-wrap inventory-table-wrap">
          <table className="data-table inventory-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>상품명</th>
                <th className="num">현재 재고</th>
                <th className="num">부족 기준</th>
                <th className="num">부가세포함 원가</th>
                <th>상태</th>
                <th>추적 시작일</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {paginatedProducts.map(product => {
                const status = getStockStatus(product);
                return (
                  <tr key={product.sku}>
                    <td><SkuCopyCell sku={product.sku} /></td>
                    <td>
                      <div className="truncate inventory-product-name" title={getProductName(product)}>
                        {getProductName(product)}
                      </div>
                      {product.brand && <small>{product.brand}</small>}
                    </td>
                    <td className="num">{Number(product.stock_quantity || 0).toLocaleString('ko-KR')}</td>
                    <td className="num">{Number(product.low_stock_threshold || 0).toLocaleString('ko-KR')}</td>
                    <td className="num">{formatWon(product.latest_unit_cost_vat)}</td>
                    <td>
                      <span className={`stock-status-pill stock-status-${status.key}`}>
                        {status.label}
                      </span>
                    </td>
                    <td>{formatDateTime(product.stock_tracking_started_at)}</td>
                    <td>
                      <div className="inventory-actions">
                        <button type="button" className="invoice-btn" onClick={() => setSettingsProduct(product)}>
                          부족기준 설정
                        </button>
                        <button type="button" className="invoice-btn" onClick={() => setAdjustProduct(product)}>
                          재고 보정
                        </button>
                        <button type="button" className="invoice-btn" onClick={() => openHistory(product)}>
                          이력보기
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="pagination-wrap">
            <button
              type="button"
              className="ghost-button"
              disabled={allSkuPage <= 1}
              onClick={() => setAllSkuPage(current => Math.max(1, current - 1))}
            >
              이전
            </button>
            <span>
              {allSkuPage} / {allSkuTotalPages} 페이지
            </span>
            <button
              type="button"
              className="ghost-button"
              disabled={allSkuPage >= allSkuTotalPages}
              onClick={() => setAllSkuPage(current => Math.min(allSkuTotalPages, current + 1))}
            >
              다음
            </button>
          </div>
        </div>
      ) : (
        <div className="table-state">재고 부족 상품이 없습니다.</div>
      )}

      {settingsProduct && (
        <StockSettingsModal
          product={settingsProduct}
          saving={saving}
          onClose={() => setSettingsProduct(null)}
          onSave={handleSaveSettings}
        />
      )}

      {adjustProduct && (
        <StockAdjustModal
          product={adjustProduct}
          saving={saving}
          onClose={() => setAdjustProduct(null)}
          onSave={handleAdjustStock}
        />
      )}

      {historyProduct && (
        <MovementsModal
          product={historyProduct}
          movements={movements}
          loading={movementsLoading}
          onClose={() => setHistoryProduct(null)}
        />
      )}
      {todayOrderLinesProduct && (
        <OrderLinesModal
          item={todayOrderLinesProduct}
          onClose={() => setTodayOrderLinesProduct(null)}
        />
      )}
      {inventoryPreviewItem && (
        <ImagePreviewModal
          item={inventoryPreviewItem}
          onClose={() => setInventoryPreviewItem(null)}
        />
      )}
      {receiptReminderResult && (
        <ReceiptSyncReminderModal
          result={receiptReminderResult}
          onClose={() => setReceiptReminderResult(null)}
        />
      )}
    </section>
  );
}
