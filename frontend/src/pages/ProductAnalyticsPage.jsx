import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fetchProductAnalytics, fetchProductAnalyticsDetail } from '../api/productAnalytics.js';

const won = value => `${Math.round(Number(value || 0)).toLocaleString('ko-KR')}원`;
const number = value => Number(value || 0).toLocaleString('ko-KR');
const percent = value => value == null ? '-' : `${Number(value).toFixed(1)}%`;
const iso = date => date.toISOString().slice(0, 10);

export default function ProductAnalyticsPage() {
  const today = new Date();
  const before = new Date(today); before.setDate(today.getDate() - 29);
  const [tab, setTab] = useState('ledger');
  const [filters, setFilters] = useState({ start_date: iso(before), end_date: iso(today), region: '', search: '' });
  const [query, setQuery] = useState(filters);
  const [data, setData] = useState({ summary: {}, rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let live = true; setLoading(true); setError('');
    fetchProductAnalytics({ ...query, page_size: 200 })
      .then(result => { if (live) setData(result); })
      .catch(err => { if (live) setError(err.message || '상품 분석 데이터를 불러오지 못했습니다.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [query]);

  async function openDetail(row) {
    setSelected(row); setDetail(null);
    try { setDetail(await fetchProductAnalyticsDetail(row.sku, query)); }
    catch (err) { setError(err.message || '상세 정보를 불러오지 못했습니다.'); }
  }

  const chartRows = useMemo(() => [...data.rows].filter(r => r.sold_qty > 0).sort((a, b) => Number(b.net_profit_krw || 0) - Number(a.net_profit_krw || 0)).slice(0, 10).map(r => ({ ...r, label: r.sku.length > 14 ? `${r.sku.slice(0, 14)}…` : r.sku })), [data.rows]);
  const s = data.summary || {};
  const cards = [
    ['분석 SKU', number(s.sku_count), '등록 상품과 판매 SKU'], ['판매수량', number(s.sold_qty), '선택 기간 판매량'],
    ['주문', number(s.order_count), 'SKU별 주문 합계'], ['매출', won(s.sales_krw), '상품 판매금액'],
    ['정산', won(s.settlement_krw), 'Shopee 실정산 배분'], ['원가', won(s.cost_krw), 'FIFO 적용 원가'],
    ['순이익', won(s.net_profit_krw), '정산 - FIFO 원가'], ['이익률', percent(s.profit_rate), '순이익 ÷ 매출'],
  ];

  return <div className="product-analytics-page">
    <header className="pa-header"><div><span className="pa-eyebrow">SHOPEE PRODUCT INTELLIGENCE</span><h1>상품 분석</h1><p>SKU를 기준으로 국가별 판매 현황과 정산·FIFO 원가·순이익을 한곳에서 확인합니다.</p></div><span className="pa-period">{query.start_date} — {query.end_date}</span></header>
    <section className="pa-toolbar">
      <label>시작일<input type="date" value={filters.start_date} onChange={e => setFilters(v => ({ ...v, start_date: e.target.value }))} /></label>
      <label>종료일<input type="date" value={filters.end_date} onChange={e => setFilters(v => ({ ...v, end_date: e.target.value }))} /></label>
      <label>국가<select value={filters.region} onChange={e => setFilters(v => ({ ...v, region: e.target.value }))}><option value="">전체 국가</option><option>SG</option><option>MY</option><option>PH</option><option>TW</option></select></label>
      <label className="pa-search">상품 검색<input placeholder="SKU, 상품명, 옵션명" value={filters.search} onChange={e => setFilters(v => ({ ...v, search: e.target.value }))} onKeyDown={e => e.key === 'Enter' && setQuery(filters)} /></label>
      <button className="pa-primary" onClick={() => setQuery(filters)}>조회</button>
      <button onClick={() => { const next = { start_date: iso(before), end_date: iso(today), region: '', search: '' }; setFilters(next); setQuery(next); }}>초기화</button>
    </section>
    {error && <div className="pa-alert error">{error}</div>}
    {(s.missing_cost_count > 0 || s.pending_settlement_orders > 0) && <div className="pa-alert"><b>확인할 항목</b>{s.missing_cost_count > 0 && <span>원가 없는 상품 {number(s.missing_cost_count)}개</span>}{s.pending_settlement_orders > 0 && <span>정산 대기 주문 {number(s.pending_settlement_orders)}건</span>}</div>}
    <div className="pa-kpis">{cards.map(([label, value, note], i) => <article key={label} className={i === 6 ? 'accent' : ''}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</div>
    <div className="pa-tabs"><button className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}>상품 통합 원장</button><button className={tab === 'performance' ? 'active' : ''} onClick={() => setTab('performance')}>상품 성과 분석</button></div>
    {tab === 'performance' && chartRows.length > 0 && <section className="pa-panel pa-chart"><div><h2>순이익 상위 상품</h2><p>선택 기간 SKU별 실정산 기준</p></div><ResponsiveContainer width="100%" height={260}><BarChart data={chartRows} margin={{ top: 10, right: 20, left: 20, bottom: 10 }}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="label" tick={{ fontSize: 11 }}/><YAxis tickFormatter={v => `${Math.round(v / 10000)}만`} tick={{ fontSize: 11 }}/><Tooltip formatter={v => won(v)} labelFormatter={(_, payload) => payload?.[0]?.payload?.sku || ''}/><Bar dataKey="net_profit_krw" name="순이익" fill="#2563eb" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></section>}
    <section className="pa-panel"><div className="pa-panel-title"><div><h2>{tab === 'ledger' ? '상품 통합 원장' : '상품별 성과'}</h2><p>행을 누르면 국가별 Shopee 상품 ID와 옵션 ID, 주문 및 재고 원가를 확인할 수 있습니다.</p></div><span>총 {number(data.total)}개 SKU</span></div>
      <div className="pa-table-wrap"><table><thead><tr><th>상품</th><th>SKU</th>{tab === 'ledger' && <><th>판매국가</th><th>재고</th></>}<th>판매수량</th><th>주문</th><th>매출</th><th>정산</th><th>원가</th><th>순이익</th><th>이익률</th><th>취소율</th></tr></thead><tbody>
        {loading ? <tr><td colSpan="12" className="pa-empty">불러오는 중입니다…</td></tr> : data.rows.length === 0 ? <tr><td colSpan="12" className="pa-empty">조건에 맞는 상품이 없습니다.</td></tr> : data.rows.map(row => <tr key={row.sku} onClick={() => openDetail(row)}><td><div className="pa-product">{row.image_url ? <img src={row.image_url} alt=""/> : <span className="pa-no-image">NO IMAGE</span>}<div><b>{row.product_name_kr || row.item_name || row.product_name_en || '-'}</b><small>{row.option_name || '-'}</small></div></div></td><td><code>{row.sku}</code></td>{tab === 'ledger' && <><td><div className="pa-tags">{String(row.regions || '').split(',').filter(Boolean).map(v => <span key={v}>{v}</span>)}</div></td><td>{number(row.stock_quantity)}</td></>}<td>{number(row.sold_qty)}</td><td>{number(row.order_count)}</td><td>{won(row.sales_krw)}</td><td>{row.settlement_krw == null ? <em>정산 대기</em> : won(row.settlement_krw)}</td><td>{won(row.cost_krw)}</td><td className={Number(row.net_profit_krw) < 0 ? 'negative' : 'positive'}>{row.net_profit_krw == null ? '-' : won(row.net_profit_krw)}</td><td>{percent(row.profit_rate)}</td><td>{percent(row.cancellation_rate)}</td></tr>)}</tbody></table></div>
    </section>
    {selected && <div className="pa-modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setSelected(null)}><section className="pa-detail"><button className="pa-close" onClick={() => setSelected(null)}>×</button><span className="pa-eyebrow">SKU DETAIL</span><h2>{selected.sku}</h2><p>{selected.product_name_kr || selected.item_name} · {selected.option_name || '옵션 없음'}</p>{!detail ? <div className="pa-empty">상세 정보를 불러오는 중입니다…</div> : <><h3>국가별 판매 상품</h3><div className="pa-country-grid">{detail.countries.map((c, i) => <article key={`${c.region}-${c.shop_id}-${i}`}><b>{c.region}</b><span>Shopee 상품 ID <strong>{c.item_id || '-'}</strong></span><span>옵션 ID <strong>{c.option_id || '-'}</strong></span><span>판매 {number(c.sold_qty)}개 · 순이익 {won(c.net_profit_krw)}</span></article>)}</div><h3>최근 주문</h3><div className="pa-table-wrap small"><table><thead><tr><th>주문번호</th><th>국가</th><th>일시</th><th>수량</th><th>순이익</th></tr></thead><tbody>{detail.orders.slice(0,20).map((o,i) => <tr key={`${o.order_sn}-${i}`}><td>{o.order_sn}</td><td>{o.region}</td><td>{String(o.order_created_at || '').slice(0,10)}</td><td>{number(o.qty)}</td><td>{o.net_profit_krw == null ? '정산 대기' : won(o.net_profit_krw)}</td></tr>)}</tbody></table></div></>}</section></div>}
  </div>;
}
