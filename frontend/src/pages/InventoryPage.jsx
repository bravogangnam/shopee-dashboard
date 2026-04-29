import { useEffect, useMemo, useState } from 'react';
import {
  adjustProductStock,
  fetchInventoryMovements,
  fetchLowStockProducts,
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

function getProductName(product) {
  return product.product_name_kr || product.product_name || product.item_name || product.product_name_en || '-';
}

function getStockStatus(product) {
  const stock = Number(product.stock_quantity || 0);
  const threshold = Number(product.low_stock_threshold || 0);
  if (stock <= 0) return { key: 'out', label: '품절' };
  if (stock <= threshold) return { key: 'low', label: '부족' };
  return { key: 'normal', label: '정상' };
}

function movementLabel(type) {
  if (type === 'SALE') return '판매 차감';
  if (type === 'CANCEL_RESTORE') return '취소 복구';
  if (type === 'MANUAL_ADJUST') return '수동 조정';
  return type || '-';
}

function movementTone(movement) {
  const qty = Number(movement.qty_delta || 0);
  if (movement.movement_type === 'SALE' || qty < 0) return 'negative';
  if (qty > 0) return 'positive';
  return '';
}

function InventoryStats({ products, refreshedAt }) {
  const outOfStockCount = products.filter(product => Number(product.stock_quantity || 0) <= 0).length;
  const thresholdValues = products
    .map(product => Number(product.low_stock_threshold))
    .filter(value => Number.isFinite(value));
  const averageThreshold = thresholdValues.length
    ? Math.round(thresholdValues.reduce((sum, value) => sum + value, 0) / thresholdValues.length)
    : 0;

  const cards = [
    { label: '재고 부족 상품', value: `${products.length.toLocaleString('ko-KR')}개`, tone: 'inventory-card-low' },
    { label: '품절 상품', value: `${outOfStockCount.toLocaleString('ko-KR')}개`, tone: 'inventory-card-out' },
    { label: '평균 경고 기준', value: `${averageThreshold.toLocaleString('ko-KR')}개`, tone: 'inventory-card-threshold' },
    { label: '마지막 새로고침', value: refreshedAt ? refreshedAt.toLocaleTimeString('ko-KR') : '-', tone: 'inventory-card-refresh' },
  ];

  return (
    <div className="inventory-stats">
      {cards.map(card => (
        <div className={`inventory-stat-card ${card.tone}`} key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
        </div>
      ))}
    </div>
  );
}

function StockSettingsModal({ product, saving, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    stock_quantity: product.stock_quantity ?? 0,
    low_stock_threshold: product.low_stock_threshold ?? 3,
    stock_tracking_started_at: formatDateTimeLocal(product.stock_tracking_started_at),
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
            <h2>재고 설정</h2>
            <p>{product.sku}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>닫기</button>
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
          <button type="submit" disabled={saving}>저장</button>
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
            <h2>수동 조정</h2>
            <p>{product.sku}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>닫기</button>
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [settingsProduct, setSettingsProduct] = useState(null);
  const [adjustProduct, setAdjustProduct] = useState(null);
  const [historyProduct, setHistoryProduct] = useState(null);
  const [movements, setMovements] = useState([]);
  const [movementsLoading, setMovementsLoading] = useState(false);

  const filteredProducts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return products.filter(product => {
      const status = getStockStatus(product);
      const matchesStatus = statusFilter === 'ALL' || status.key === statusFilter;
      const haystack = `${product.sku || ''} ${getProductName(product)} ${product.product_name_en || ''}`.toLowerCase();
      const matchesKeyword = !keyword || haystack.includes(keyword);
      return matchesStatus && matchesKeyword;
    });
  }, [products, search, statusFilter]);

  async function loadProducts() {
    setLoading(true);
    setError('');
    try {
      const result = await fetchLowStockProducts();
      setProducts(result);
      setRefreshedAt(new Date());
    } catch (err) {
      setError(err.message || '재고 목록을 불러오지 못했습니다.');
      setProducts([]);
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
      setMessage('재고 설정을 저장했습니다.');
      setSettingsProduct(null);
      await loadProducts();
    } catch (err) {
      setError(err.message || '재고 설정 저장에 실패했습니다.');
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

  return (
    <section className="page inventory-page">
      <div className="page-header">
        <div>
          <h1>재고 관리</h1>
          <p>내부 DB 기준 재고를 관리합니다. Shopee 실제 재고와는 연동하지 않습니다.</p>
        </div>
        <div className="action-buttons">
          <button type="button" className="action-btn" onClick={loadProducts} disabled={loading}>
            {loading ? '새로고침 중' : '새로고침'}
          </button>
          <button
            type="button"
            className={`action-btn ${statusFilter !== 'ALL' ? 'primary' : ''}`}
            onClick={() => setStatusFilter(current => (current === 'ALL' ? 'low' : 'ALL'))}
          >
            재고 부족만 보기
          </button>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="alert">{error}</div>}

      <InventoryStats products={products} refreshedAt={refreshedAt} />

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
            <option value="out">품절</option>
            <option value="low">부족</option>
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
                          재고 설정
                        </button>
                        <button type="button" className="invoice-btn" onClick={() => setAdjustProduct(product)}>
                          수동 조정
                        </button>
                        <button type="button" className="invoice-btn" onClick={() => openHistory(product)}>
                          이력 보기
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
