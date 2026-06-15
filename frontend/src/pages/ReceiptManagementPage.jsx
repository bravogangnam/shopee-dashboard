import { useEffect, useMemo, useState } from 'react';
import { fetchReceiptDashboard, fetchSkuCompositions } from '../api/receipts.js';

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

function formatDate(value) {
  if (!value) return '-';
  return String(value).replace('T', ' ').replace('.000Z', '').slice(0, 16);
}

function productName(row, prefix = '') {
  return row?.[`${prefix}product_name_kr`] || row?.[`${prefix}product_name_en`] || row?.product_name_kr || row?.product_name_en || '-';
}

function optionName(row, prefix = '') {
  return row?.[`${prefix}option_name`] || row?.option_name || '-';
}

function compositionTone(type) {
  if (type === '공통') return 'receipt-pill receipt-pill-common';
  if (type === '판매') return 'receipt-pill receipt-pill-sale';
  if (type === '세트') return 'receipt-pill receipt-pill-set';
  return 'receipt-pill';
}

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

  return (
    <div className="receipt-tab-grid">
      <section className="receipt-card receipt-card-wide">
        <div className="receipt-section-header">
          <div>
            <h2>구매필요 상품</h2>
            <p>재고가 부족한 상품을 자동으로 표시합니다. 다음 단계에서 여기서 바로 입고등록을 연결합니다.</p>
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
              {purchaseNeeded.length ? purchaseNeeded.map(product => (
                <tr key={product.sku}>
                  <td><strong>{product.sku}</strong></td>
                  <td>{product.product_name_kr || product.product_name_en || '-'}</td>
                  <td>{product.option_name || '-'}</td>
                  <td className={Number(product.stock_quantity || 0) < 0 ? 'receipt-negative' : ''}>
                    {formatNumber(product.stock_quantity)}
                  </td>
                  <td><strong>{formatNumber(product.purchase_needed_qty)}</strong></td>
                  <td>{formatKrw(product.cost_price_with_vat || product.discounted_price_with_vat || 0)}</td>
                  <td>{product.supply_rate ? `${formatNumber(product.supply_rate, 2)}%` : '100%'}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="7" className="receipt-empty">구매필요 상품이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
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
            <span>실제 입고단가 / 부가세제외 원가 / 저장 후 재고를 자동 계산합니다.</span>
          </div>
        </div>
      </section>

      <section className="receipt-card receipt-card-wide">
        <div className="receipt-section-header">
          <div>
            <h2>최근 입고 이력</h2>
            <p>현재 inventory_batches 기준 최근 입고 배치를 그대로 표시합니다.</p>
          </div>
        </div>

        <div className="receipt-table-wrap">
          <table className="receipt-table">
            <thead>
              <tr>
                <th>입고일</th>
                <th>입고번호</th>
                <th>SKU</th>
                <th>상품명</th>
                <th>입고수량</th>
                <th>남은수량</th>
                <th>부가세제외 원가</th>
                <th>메모</th>
              </tr>
            </thead>
            <tbody>
              {recentReceipts.length ? recentReceipts.map(row => (
                <tr key={row.id}>
                  <td>{formatDate(row.received_at || row.created_at)}</td>
                  <td>{row.receipt_id || '-'}</td>
                  <td><strong>{row.sku}</strong></td>
                  <td>{row.product_name_kr || row.product_name_en || '-'}</td>
                  <td>{formatNumber(row.initial_qty)}</td>
                  <td>{formatNumber(row.remaining_qty)}</td>
                  <td>{formatKrw(row.unit_cost)}</td>
                  <td>{row.note || '-'}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="8" className="receipt-empty">입고 이력이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function CompositionTab({ rows, summary, search, setSearch, loading }) {
  const visibleSummary = [
    { label: '전체 구성', value: summary?.total_count || 0 },
    { label: '공통', value: summary?.common_count || 0 },
    { label: '판매', value: summary?.sale_count || 0 },
    { label: '세트', value: summary?.set_count || 0 },
  ];

  return (
    <section className="receipt-card">
      <div className="receipt-section-header receipt-section-header-row">
        <div>
          <h2>상품구성표</h2>
          <p>기존 시트 동기화 데이터인 sku_compositions를 시트형으로 표시합니다. 수정 기능은 검증 후 엽니다.</p>
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
              <th>시트행</th>
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
                <td>{formatNumber(row.factor, 2)}</td>
                <td><span className={compositionTone(row.composition_type)}>{row.composition_type || '-'}</span></td>
                <td>{row.note || '-'}</td>
                <td>{row.sheet_row || '-'}</td>
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

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        setCompositionLoading(true);
        const result = await fetchSkuCompositions(compositionSearch);
        if (!alive) return;
        setCompositionRows(result.data || []);
        setCompositionSummary(result.summary || null);
      } catch (err) {
        if (alive) setError(err.message || '상품구성표를 불러오지 못했습니다.');
      } finally {
        if (alive) setCompositionLoading(false);
      }
    }, 250);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
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
        />
      )}
    </div>
  );
}
