import { useEffect, useMemo, useState } from 'react';
import {
  adjustProductStock,
  fetchInventoryMovements,
  fetchInventoryProducts,
  syncInventoryReceipts,
  updateProductStock,
} from '../api/products.js';

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
  if (stock <= 0) return { key: 'out_of_stock', label: '품절' };
  if (stock <= threshold) return { key: 'low_stock', label: '재고부족' };
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

function InventoryStats({ products, summary }) {
  const fallbackSummary = {
    out_of_stock_count: products.filter(product => Number(product.stock_quantity || 0) <= 0).length,
    low_stock_count: products.filter(product => (
      Number(product.stock_quantity || 0) <= Number(product.low_stock_threshold || 0)
    )).length,
    in_stock_sku_count: products.filter(product => Number(product.stock_quantity || 0) > 0).length,
    total_stock_quantity: products.reduce((sum, product) => sum + Number(product.stock_quantity || 0), 0),
    total_inventory_value: 0,
  };
  const stats = summary || fallbackSummary;

  const cards = [
    {
      label: '품절 상품',
      value: `${Number(stats.out_of_stock_count || 0).toLocaleString('ko-KR')}개`,
      sub: '재고 0개',
      tone: 'inventory-card-out',
    },
    {
      label: '재고 부족 상품',
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
      label: '총 보유 수량',
      value: `${Number(stats.total_stock_quantity || 0).toLocaleString('ko-KR')}개`,
      sub: '입고관리 기준',
      tone: 'inventory-card-quantity',
    },
    {
      label: '총 재고액',
      value: formatKrw(stats.total_inventory_value),
      sub: 'VAT 제외 / FIFO 잔량 기준',
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
  const [qtyDelta, setQtyDelta] = useState('');
  const [note, setNote] = useState('');
  const presets = [1, 5, -1, -5];

  function handleSubmit(event) {
    event.preventDefault();
    const parsedDelta = Number.parseInt(qtyDelta, 10);
    if (!Number.isFinite(parsedDelta) || parsedDelta === 0) return;
    onSave({ qty_delta: parsedDelta, note });
  }

  return (
    <div className="modal-backdrop">
      <form className="modal-card inventory-modal" onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <h2>재고 조정</h2>
            <p>{product.sku}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>닫기</button>
        </div>

        <div className="inventory-help-text">
          입고는 구글시트 입고관리탭에 입력하세요.
          재고조정은 파손, 분실, 실사 차이, 오입력 보정 같은 예외 상황에서만 사용합니다.
        </div>

        <div className="adjust-presets">
          {presets.map(value => (
            <button
              type="button"
              className="action-btn"
              onClick={() => setQtyDelta(String(value))}
              key={value}
            >
              {value > 0 ? `+${value}` : value}
            </button>
          ))}
        </div>

        <label>
          조정 수량
          <input
            type="number"
            step="1"
            value={qtyDelta}
            onChange={event => setQtyDelta(event.target.value)}
            placeholder="예: -1 또는 5"
          />
        </label>
        <label>
          메모
          <input
            value={note}
            onChange={event => setNote(event.target.value)}
            placeholder="manual correction"
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>취소</button>
          <button type="submit" disabled={saving || Number.parseInt(qtyDelta, 10) === 0}>
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

export default function InventoryPage() {
  const [products, setProducts] = useState([]);
  const [inventorySummary, setInventorySummary] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [settingsProduct, setSettingsProduct] = useState(null);
  const [adjustProduct, setAdjustProduct] = useState(null);
  const [historyProduct, setHistoryProduct] = useState(null);
  const [movements, setMovements] = useState([]);
  const [movementsLoading, setMovementsLoading] = useState(false);

  const filteredProducts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return products.filter(product => {
      const stockQty = Number(product.stock_quantity || 0);
      const threshold = Number(product.low_stock_threshold || 0);
      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'in_stock' && stockQty > 0) ||
        (statusFilter === 'low_stock' && stockQty <= threshold) ||
        (statusFilter === 'out_of_stock' && stockQty <= 0);
      const haystack = `${product.sku || ''} ${getProductName(product)} ${product.product_name_en || ''}`.toLowerCase();
      const matchesKeyword = !keyword || haystack.includes(keyword);
      return matchesStatus && matchesKeyword;
    });
  }, [products, search, statusFilter]);

  async function loadProducts() {
    setLoading(true);
    setError('');
    try {
      const result = await fetchInventoryProducts();
      setProducts(result.data);
      setInventorySummary(result.summary);
      setRefreshedAt(new Date());
    } catch (err) {
      setError(err.message || '재고 목록을 불러오지 못했습니다.');
      setProducts([]);
      setInventorySummary(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProducts();
  }, []);

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
    if (!payload.qty_delta) {
      setError('조정 수량은 0일 수 없습니다.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await adjustProductStock(adjustProduct.sku, payload);
      setMessage('재고를 조정했습니다.');
      setAdjustProduct(null);
      await loadProducts();
      if (historyProduct?.sku === adjustProduct.sku) {
        await openHistory(adjustProduct);
      }
    } catch (err) {
      setError(err.message || '재고 조정에 실패했습니다.');
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
    try {
      const response = await syncInventoryReceipts();
      const result = response.result || response;
      setSyncResult(result);
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
            재고 수량은 구글시트 입고관리탭을 기준으로 반영할 예정입니다.
            현재 보유 재고와 추가 입고는 입고관리탭에 입력하세요.
            이 화면의 재고조정은 파손, 분실, 실사 차이 같은 예외 보정용입니다.
            Shopee 실제 재고와는 연동하지 않습니다.
          </p>
        </div>
        <div className="action-buttons">
          <button type="button" className="action-btn" onClick={loadProducts} disabled={loading}>
            {loading ? '새로고침 중' : '새로고침'}
          </button>
          <button
            type="button"
            className={`action-btn ${statusFilter !== 'ALL' ? 'primary' : ''}`}
            onClick={() => setStatusFilter(current => (current === 'ALL' ? 'low_stock' : 'ALL'))}
          >
            재고 부족만 보기
          </button>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="alert">{error}</div>}

      <div className="receipt-sync-panel">
        <div>
          <strong>입고관리 동기화</strong>
          <p>
            구글시트 입고관리탭의 ‘대기’ 행을 DB 재고와 FIFO batch에 반영합니다.
            성공한 행은 시트에서 ‘동기화완료’로 변경하세요.
          </p>
        </div>
        <button type="button" className="action-btn primary" onClick={handleReceiptSync} disabled={syncLoading}>
          {syncLoading ? '동기화 중...' : '입고관리 동기화'}
        </button>
      </div>

      <ReceiptSyncResultCard result={syncResult} />

      <InventoryStats products={products} summary={inventorySummary} />
      <div className="inventory-refresh-note">
        마지막 갱신: {refreshedAt ? refreshedAt.toLocaleTimeString('ko-KR') : '-'}
      </div>

      <div className="inventory-filters">
        <label className="filter-field order-search-field">
          SKU 또는 상품명
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="SKU / 상품명 검색"
          />
        </label>
        <label className="filter-field">
          상태
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
            <option value="ALL">전체</option>
            <option value="in_stock">재고보유</option>
            <option value="low_stock">재고부족</option>
            <option value="out_of_stock">품절</option>
          </select>
        </label>
      </div>

      {loading ? (
        <div className="table-state">재고 목록을 불러오는 중...</div>
      ) : filteredProducts.length ? (
        <div className="table-wrap inventory-table-wrap">
          <table className="data-table inventory-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>상품명</th>
                <th className="num">현재 재고</th>
                <th className="num">부족 기준</th>
                <th>상태</th>
                <th>추적 시작일</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map(product => {
                const status = getStockStatus(product);
                return (
                  <tr key={product.sku}>
                    <td><strong>{product.sku}</strong></td>
                    <td>
                      <div className="truncate inventory-product-name" title={getProductName(product)}>
                        {getProductName(product)}
                      </div>
                      {product.brand && <small>{product.brand}</small>}
                    </td>
                    <td className="num">{Number(product.stock_quantity || 0).toLocaleString('ko-KR')}</td>
                    <td className="num">{Number(product.low_stock_threshold || 0).toLocaleString('ko-KR')}</td>
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
                          재고조정
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
    </section>
  );
}
