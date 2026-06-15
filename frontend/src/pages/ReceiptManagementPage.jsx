import { useEffect, useMemo, useState } from 'react';
import { createSkuComposition, deleteSkuComposition, fetchReceiptDashboard, fetchSkuCompositions, searchReceiptProducts, updateSkuComposition } from '../api/receipts.js';

function formatNumber(value, digits = 0) {
  const number = Number(value || 0);
  return number.toLocaleString('ko-KR', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatKrw(value) {
  const number = Math.round(Number(value || 0));
  return `₩${number.toLocaleString('ko-KR')}`;
}


function formatSupplyRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '100%';
  const percent = number <= 1 ? number * 100 : number;
  return `${Math.round(percent).toLocaleString('ko-KR')}%`;
}

function formatDate(value) {
  if (!value) return '-';
  return String(value).replace('T', ' ').replace('.000Z', '').slice(0, 10);
}

function productName(row, prefix = '') {
  return row?.[`${prefix}product_name_kr`] || row?.[`${prefix}product_name_en`] || row?.product_name_kr || row?.product_name_en || '-';
}

function optionName(row, prefix = '') {
  return row?.[`${prefix}option_name`] || row?.option_name || '-';
}

const RECEIPT_PAGE_SIZE = 20;
const PURCHASE_PAGE_SIZE = 20;

function compositionTone(type) {
  if (type === '공통') return 'receipt-pill receipt-pill-common';
  if (type === '판매') return 'receipt-pill receipt-pill-sale';
  if (type === '세트') return 'receipt-pill receipt-pill-set';
  return 'receipt-pill';
}

function ProductPicker({ label, value, onChange, placeholder }) {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    let alive = true;
    const keyword = query.trim();

    if (!open || keyword.length < 2) {
      setResults([]);
      return () => {
        alive = false;
      };
    }

    const timer = setTimeout(async () => {
      try {
        const result = await searchReceiptProducts(keyword);
        if (alive) setResults(result.data || []);
      } catch {
        if (alive) setResults([]);
      }
    }, 180);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, open]);

  function selectProduct(product) {
    onChange(product.sku);
    setQuery(product.sku);
    setOpen(false);
  }

  return (
    <label className="composition-field product-picker">
      <span>{label}</span>
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={event => {
          setQuery(event.target.value);
          onChange(event.target.value);
          setOpen(true);
        }}
      />
      {open && results.length > 0 && (
        <div className="product-picker-results">
          {results.map(product => (
            <button type="button" key={product.sku} onClick={() => selectProduct(product)}>
              <strong>{product.sku}</strong>
              <span>{product.product_name_kr || product.product_name_en || '-'}</span>
              <small>{product.option_name || '-'}</small>
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

const EMPTY_COMPOSITION_FORM = {
  id: null,
  source_sku: '',
  base_sku: '',
  factor: '1',
  composition_type: '공통',
  note: '',
};

function ReceiptOverview({ dashboard }) {
  const summary = dashboard?.summary || {};
  const cards = [
    { label: '마이너스 재고', value: `${formatNumber(summary.negative_stock_count)}개`, sub: '즉시 입고 필요' },
    { label: '품절 SKU', value: `${formatNumber(summary.out_of_stock_count)}개`, sub: '재고 0' },
    { label: '재고부족 SKU', value: `${formatNumber(summary.low_stock_count)}개`, sub: '부족 기준 이하' },
    { label: '전체 상품', value: `${formatNumber(summary.total_product_count)}개`, sub: '등록 상품 기준' },
  ];

  return (
    <div className="receipt-summary-grid">
      {cards.map(card => (
        <div className="receipt-summary-card" key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.sub}</small>
        </div>
      ))}
    </div>
  );
}

function StockInTab({ dashboard }) {
  const purchaseNeeded = dashboard?.purchase_needed || [];
  const recentReceipts = dashboard?.recent_receipts || [];
  const [purchasePage, setPurchasePage] = useState(1);
  const [receiptPage, setReceiptPage] = useState(1);

  const purchaseTotalPages = Math.max(1, Math.ceil(purchaseNeeded.length / PURCHASE_PAGE_SIZE));
  const safePurchasePage = Math.min(purchasePage, purchaseTotalPages);
  const pagedPurchaseNeeded = purchaseNeeded.slice(
    (safePurchasePage - 1) * PURCHASE_PAGE_SIZE,
    safePurchasePage * PURCHASE_PAGE_SIZE
  );

  const receiptTotalPages = Math.max(1, Math.ceil(recentReceipts.length / RECEIPT_PAGE_SIZE));
  const safeReceiptPage = Math.min(receiptPage, receiptTotalPages);
  const pagedReceipts = recentReceipts.slice(
    (safeReceiptPage - 1) * RECEIPT_PAGE_SIZE,
    safeReceiptPage * RECEIPT_PAGE_SIZE
  );

  useEffect(() => {
    setPurchasePage(1);
  }, [purchaseNeeded.length]);

  useEffect(() => {
    setReceiptPage(1);
  }, [recentReceipts.length]);

  return (
    <div className="receipt-tab-grid">
      <section className="receipt-card receipt-card-wide">
        <div className="receipt-section-header">
          <div>
            <h2>구매필요 상품</h2>
            <p>현재재고가 마이너스인 실제 구매필요 상품만 표시합니다.</p>
          </div>
        </div>

        <div className="receipt-table-wrap">
          <table className="receipt-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>상품명</th>
                <th>옵션</th>
                <th>현재재고</th>
                <th>구매필요</th>
                <th>최근 원가</th>
                <th>공급률</th>
              </tr>
            </thead>
            <tbody>
              {pagedPurchaseNeeded.length ? pagedPurchaseNeeded.map(product => (
                <tr key={product.sku}>
                  <td><strong>{product.sku}</strong></td>
                  <td>{product.product_name_kr || product.product_name_en || '-'}</td>
                  <td>{product.option_name || '-'}</td>
                  <td className={Number(product.stock_quantity || 0) < 0 ? 'receipt-negative' : ''}>
                    {formatNumber(product.stock_quantity)}
                  </td>
                  <td><strong>{formatNumber(product.purchase_needed_qty)}</strong></td>
                  <td>{formatKrw(product.cost_price_with_vat || product.discounted_price_with_vat || 0)}</td>
                  <td>{formatSupplyRate(product.supply_rate)}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="7" className="receipt-empty">구매필요 상품이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="receipt-pagination">
          <span>
            구매필요 상품 {formatNumber(purchaseNeeded.length)}개 · {formatNumber(safePurchasePage)} / {formatNumber(purchaseTotalPages)} 페이지
          </span>
          <div>
            <button
              type="button"
              onClick={() => setPurchasePage(page => Math.max(1, page - 1))}
              disabled={safePurchasePage <= 1}
            >
              이전
            </button>
            <button
              type="button"
              onClick={() => setPurchasePage(page => Math.min(purchaseTotalPages, page + 1))}
              disabled={safePurchasePage >= purchaseTotalPages}
            >
              다음
            </button>
          </div>
        </div>
      </section>

      <section className="receipt-card">
        <div className="receipt-section-header">
          <div>
            <h2>신규 입고 등록</h2>
            <p>다음 단계에서 상품검색, 입고예정/입고완료, 공급처, 공급률 입력을 연결합니다.</p>
          </div>
        </div>

        <div className="receipt-form-preview">
          <label>
            상품 검색
            <input type="text" placeholder="SKU / 상품명 / 옵션명 통합검색" disabled />
          </label>
          <div className="receipt-form-row">
            <label>
              입고수량
              <input type="number" placeholder="구매필요수량 자동입력 예정" disabled />
            </label>
            <label>
              공급률
              <input type="text" value="100%" disabled readOnly />
            </label>
          </div>
          <label>
            부가세포함 단가
            <input type="text" placeholder="최근 입고가 자동입력 예정" disabled />
          </label>
          <div className="receipt-preview-box">
            <span>입력한 부가세포함 단가 기준으로 입고단가와 저장 후 재고를 자동 계산합니다.</span>
          </div>
        </div>
      </section>

      <section className="receipt-card receipt-card-wide">
        <div className="receipt-section-header">
          <div>
            <h2>최근 입고 이력</h2>
            <p>입고 완료된 내역을 날짜 기준으로 표시합니다.</p>
          </div>
        </div>

        <div className="receipt-table-wrap">
          <table className="receipt-table">
            <thead>
              <tr>
                <th>입고일</th>
                <th>SKU</th>
                <th>상품명</th>
                <th>입고수량</th>
                <th>남은수량</th>
                <th>부가세포함 원가</th>
                <th>메모</th>
              </tr>
            </thead>
            <tbody>
              {pagedReceipts.length ? pagedReceipts.map(row => (
                <tr key={row.id}>
                  <td>{formatDate(row.received_at || row.created_at)}</td>
                  <td><strong>{row.sku}</strong></td>
                  <td>{row.product_name_kr || row.product_name_en || '-'}</td>
                  <td>{formatNumber(row.initial_qty)}</td>
                  <td>{formatNumber(row.remaining_qty)}</td>
                  <td>{formatKrw(Number(row.unit_cost || 0) * 1.1)}</td>
                  <td>{row.note || '-'}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="7" className="receipt-empty">입고 이력이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="receipt-pagination">
          <span>
            최근 입고 이력 {formatNumber(recentReceipts.length)}건 · {formatNumber(safeReceiptPage)} / {formatNumber(receiptTotalPages)} 페이지
          </span>
          <div>
            <button
              type="button"
              onClick={() => setReceiptPage(page => Math.max(1, page - 1))}
              disabled={safeReceiptPage <= 1}
            >
              이전
            </button>
            <button
              type="button"
              onClick={() => setReceiptPage(page => Math.min(receiptTotalPages, page + 1))}
              disabled={safeReceiptPage >= receiptTotalPages}
            >
              다음
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function CompositionTab({ rows, summary, search, setSearch, loading, reload }) {
  const [form, setForm] = useState(EMPTY_COMPOSITION_FORM);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const visibleSummary = [
    { label: '전체 구성', value: summary?.total_count || 0 },
    { label: '공통', value: summary?.common_count || 0 },
    { label: '판매', value: summary?.sale_count || 0 },
    { label: '세트', value: summary?.set_count || 0 },
  ];

  const isEditing = Boolean(form.id);

  function updateForm(field, value) {
    setForm(current => ({ ...current, [field]: value }));
  }

  function resetForm() {
    setForm(EMPTY_COMPOSITION_FORM);
    setMessage('');
  }

  function startEdit(row) {
    setForm({
      id: row.id,
      source_sku: row.source_sku || '',
      base_sku: row.base_sku || '',
      factor: String(Math.trunc(Number(row.factor || 1))),
      composition_type: row.composition_type || '공통',
      note: row.note || '',
    });
    setMessage('수정할 내용을 입력하고 저장하세요.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submitForm(event) {
    event.preventDefault();

    const payload = {
      source_sku: form.source_sku,
      base_sku: form.base_sku,
      factor: form.factor,
      composition_type: form.composition_type,
      note: form.note,
    };

    try {
      setSaving(true);
      setMessage('');

      if (form.id) {
        await updateSkuComposition(form.id, payload);
        setMessage('상품구성을 수정했습니다.');
      } else {
        await createSkuComposition(payload);
        setMessage('상품구성을 추가했습니다.');
      }

      setForm(EMPTY_COMPOSITION_FORM);
      await reload();
    } catch (err) {
      setMessage(err.message || '저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }

  async function removeRow(row) {
    if (!window.confirm(`${row.source_sku} → ${row.base_sku} 구성을 삭제할까요?`)) return;

    try {
      setSaving(true);
      await deleteSkuComposition(row.id);
      setMessage('상품구성을 삭제했습니다.');
      if (form.id === row.id) setForm(EMPTY_COMPOSITION_FORM);
      await reload();
    } catch (err) {
      setMessage(err.message || '삭제에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="receipt-card">
      <div className="receipt-section-header receipt-section-header-row">
        <div>
          <h2>상품구성표</h2>
          <p>기존 시트처럼 한 줄씩 추가·수정합니다. 저장 즉시 FIFO가 읽는 sku_compositions 기준에 반영됩니다.</p>
        </div>
      </div>

      <div className="receipt-mini-stats">
        {visibleSummary.map(item => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{formatNumber(item.value)}</strong>
          </div>
        ))}
      </div>

      <form className="composition-editor" onSubmit={submitForm}>
        <div className="composition-editor-title">
          <strong>{isEditing ? '상품구성 수정' : '상품구성 추가'}</strong>
          <span>예: GS_01552 → GS_01511 × 2</span>
        </div>

        <div className="composition-editor-grid">
          <ProductPicker
            label="SKU"
            value={form.source_sku}
            onChange={value => updateForm('source_sku', value)}
            placeholder="판매 SKU 또는 상품명 검색"
          />

          <ProductPicker
            label="기준재고SKU"
            value={form.base_sku}
            onChange={value => updateForm('base_sku', value)}
            placeholder="실제 차감할 SKU 검색"
          />

          <label className="composition-field">
            <span>기준수량</span>
            <input
              type="number"
              min="1"
              step="1"
              value={form.factor}
              onChange={event => updateForm('factor', event.target.value)}
            />
          </label>

          <label className="composition-field">
            <span>구분</span>
            <select
              value={form.composition_type}
              onChange={event => updateForm('composition_type', event.target.value)}
            >
              <option value="공통">공통</option>
              <option value="판매">판매</option>
              <option value="세트">세트</option>
            </select>
          </label>

          <label className="composition-field composition-note-field">
            <span>메모</span>
            <input
              type="text"
              value={form.note}
              onChange={event => updateForm('note', event.target.value)}
              placeholder="예: 2개 판매, 세트 구성 등"
            />
          </label>
        </div>

        <div className="composition-editor-actions">
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? '저장 중...' : isEditing ? '수정 저장' : '구성 추가'}
          </button>
          <button type="button" className="secondary-button" onClick={resetForm} disabled={saving}>
            초기화
          </button>
          {message && <span className="composition-message">{message}</span>}
        </div>
      </form>

      <div className="receipt-toolbar">
        <input
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="SKU / 기준재고SKU / 상품명 / 메모 통합검색"
        />
        <span>{loading ? '불러오는 중...' : `${formatNumber(rows.length)}개 표시`}</span>
      </div>

      <div className="receipt-table-wrap">
        <table className="receipt-table receipt-composition-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>판매상품명</th>
              <th>기준재고SKU</th>
              <th>기준상품명</th>
              <th>기준수량</th>
              <th>구분</th>
              <th>메모</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map(row => (
              <tr key={row.id}>
                <td><strong>{row.source_sku}</strong></td>
                <td>
                  <div className="receipt-product-name">{productName(row, 'source_')}</div>
                  <small>{optionName(row, 'source_')}</small>
                </td>
                <td><strong>{row.base_sku}</strong></td>
                <td>
                  <div className="receipt-product-name">{productName(row, 'base_')}</div>
                  <small>현재재고 {formatNumber(row.base_stock_quantity)}</small>
                </td>
                <td>{formatNumber(row.factor, 0)}</td>
                <td><span className={compositionTone(row.composition_type)}>{row.composition_type || '-'}</span></td>
                <td>{row.note || '-'}</td>
                <td>
                  <div className="composition-row-actions">
                    <button type="button" onClick={() => startEdit(row)}>수정</button>
                    <button type="button" className="danger" onClick={() => removeRow(row)}>삭제</button>
                  </div>
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan="8" className="receipt-empty">상품구성표 데이터가 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ReceiptManagementPage() {
  const [activeTab, setActiveTab] = useState('stock-in');
  const [dashboard, setDashboard] = useState(null);
  const [compositionRows, setCompositionRows] = useState([]);
  const [compositionSummary, setCompositionSummary] = useState(null);
  const [compositionSearch, setCompositionSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [compositionLoading, setCompositionLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;

    async function loadDashboard() {
      try {
        setLoading(true);
        setError('');
        const result = await fetchReceiptDashboard();
        if (alive) setDashboard(result);
      } catch (err) {
        if (alive) setError(err.message || '입고관리 데이터를 불러오지 못했습니다.');
      } finally {
        if (alive) setLoading(false);
      }
    }

    loadDashboard();
    return () => {
      alive = false;
    };
  }, []);

  async function loadCompositions(keyword = compositionSearch) {
    try {
      setCompositionLoading(true);
      const result = await fetchSkuCompositions(keyword);
      setCompositionRows(result.data || []);
      setCompositionSummary(result.summary || null);
    } catch (err) {
      setError(err.message || '상품구성표를 불러오지 못했습니다.');
    } finally {
      setCompositionLoading(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      loadCompositions(compositionSearch);
    }, 250);

    return () => clearTimeout(timer);
  }, [compositionSearch]);

  const tabLabel = useMemo(() => {
    if (activeTab === 'composition') return '상품구성표';
    return '입고 관리';
  }, [activeTab]);

  return (
    <div className="receipt-page">
      <header className="receipt-page-header">
        <div>
          <p className="eyebrow">Inventory Operations</p>
          <h1>입고 관리</h1>
          <p>입고 등록, 입고 이력, 상품구성표를 한 곳에서 관리합니다. 기존 재고관리 화면은 건드리지 않습니다.</p>
        </div>
      </header>

      <div className="receipt-tabs" role="tablist" aria-label="입고 관리 탭">
        <button
          type="button"
          className={activeTab === 'stock-in' ? 'active' : ''}
          onClick={() => setActiveTab('stock-in')}
        >
          입고 관리
        </button>
        <button
          type="button"
          className={activeTab === 'composition' ? 'active' : ''}
          onClick={() => setActiveTab('composition')}
        >
          상품구성표
        </button>
      </div>

      {error && <div className="receipt-alert">{error}</div>}

      <div className="receipt-current-tab">{tabLabel}</div>

      {activeTab === 'stock-in' && (
        <>
          {loading ? <div className="receipt-card">입고관리 데이터를 불러오는 중입니다.</div> : <ReceiptOverview dashboard={dashboard} />}
          <StockInTab dashboard={dashboard} />
        </>
      )}

      {activeTab === 'composition' && (
        <CompositionTab
          rows={compositionRows}
          summary={compositionSummary}
          search={compositionSearch}
          setSearch={setCompositionSearch}
          loading={compositionLoading}
          reload={() => loadCompositions(compositionSearch)}
        />
      )}
    </div>
  );
}
