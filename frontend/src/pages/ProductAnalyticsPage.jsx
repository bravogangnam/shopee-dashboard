import { useEffect, useMemo, useState } from 'react';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import QuickDateRangePicker from '../components/QuickDateRangePicker.jsx';
import { fetchProductAnalytics, fetchProductAnalyticsDetail } from '../api/productAnalytics.js';

const { RangePicker } = DatePicker;
const won = value => `${Math.round(Number(value || 0)).toLocaleString('ko-KR')}원`;
const num = value => Number(value || 0).toLocaleString('ko-KR');
const pct = value => value == null ? '-' : `${Number(value).toFixed(1)}%`;
const iso = date => date.toISOString().slice(0, 10);
const SORTS = [
  ['net_profit_krw','순이익'], ['sales_krw','매출'], ['settlement_krw','정산'], ['cost_krw','원가'],
  ['sold_qty','판매수량'], ['order_count','주문'], ['profit_rate','이익률'], ['cancellation_rate','취소율'],
  ['stock_quantity','재고'], ['last_sold_at','최근 판매일'], ['sku','SKU'],
];
const profitTone = value => value == null ? 'neutral' : value < 0 ? 'bad' : value < 1000 ? 'neutral' : value >= 100000 ? 'great' : 'good';
const marginTone = value => value == null ? 'neutral' : value < 0 ? 'bad' : value < 10 ? 'warn' : value < 20 ? 'info' : value < 30 ? 'good' : 'great';
const cancelTone = value => value > 10 ? 'bad' : value > 5 ? 'warn' : value > 2 ? 'info' : 'good';

function SortHead({ field, children, query, changeSort }) {
  const active = query.sort === field;
  return <th><button className={active ? 'pa-sort active' : 'pa-sort'} onClick={() => changeSort(field)}>{children}<span>{active ? (query.direction === 'desc' ? '↓' : '↑') : '↕'}</span></button></th>;
}

export default function ProductAnalyticsPage() {
  const today = new Date(); const before = new Date(today); before.setDate(today.getDate() - 29);
  const initial = { start_date: iso(before), end_date: iso(today), region: '', search: '', sort: 'net_profit_krw', direction: 'desc', page: 1, page_size: 50 };
  const [tab,setTab] = useState('ledger'); const [filters,setFilters] = useState(initial); const [query,setQuery] = useState(initial);
  const [data,setData] = useState({ summary:{}, rows:[], total:0, page:1, page_size:50 }); const [loading,setLoading] = useState(true);
  const [error,setError] = useState(''); const [notice,setNotice] = useState(''); const [selected,setSelected] = useState(null); const [detail,setDetail] = useState(null);

  useEffect(() => { let live=true; setLoading(true); setError(''); fetchProductAnalytics(query).then(x=>live&&setData(x)).catch(e=>live&&setError(e.message||'데이터를 불러오지 못했습니다.')).finally(()=>live&&setLoading(false)); return()=>{live=false}; },[query]);
  useEffect(() => { if (!notice) return undefined; const id=setTimeout(()=>setNotice(''),1800); return()=>clearTimeout(id); },[notice]);
  async function openDetail(row){ setSelected(row); setDetail(null); try{setDetail(await fetchProductAnalyticsDetail(row.sku,query));}catch(e){setError(e.message||'상세 정보를 불러오지 못했습니다.');} }
  function apply(){setQuery({...filters,page:1});}
  function changeSort(sort){const direction=query.sort===sort&&query.direction==='desc'?'asc':'desc';setFilters(v=>({...v,sort,direction}));setQuery(v=>({...v,sort,direction,page:1}));}
  function go(page){setQuery(v=>({...v,page}));}
  async function copySku(sku){try{await navigator.clipboard.writeText(sku);setNotice(`SKU ${sku} 복사 완료`);}catch{setNotice('SKU 복사에 실패했습니다.');}}
  const pages=Math.max(1,Math.ceil(data.total/50)); const start=data.total?(data.page-1)*50+1:0; const end=Math.min(data.page*50,data.total);
  const chartRows=useMemo(()=>[...data.rows].filter(r=>r.sold_qty>0).sort((a,b)=>Number(b.net_profit_krw||0)-Number(a.net_profit_krw||0)).slice(0,10).map(r=>({...r,label:r.sku.length>14?`${r.sku.slice(0,14)}…`:r.sku})),[data.rows]);
  const s=data.summary||{}; const cards=[['분석 SKU',num(s.sku_count),'등록 상품과 판매 SKU'],['판매수량',num(s.sold_qty),'선택 기간 판매량'],['주문',num(s.order_count),'SKU별 주문 합계'],['매출',won(s.sales_krw),'상품 판매금액'],['정산',won(s.settlement_krw),'Shopee 실정산 배분'],['원가',won(s.cost_krw),'FIFO 적용 원가'],['순이익',won(s.net_profit_krw),'정산 - FIFO 원가'],['이익률',pct(s.profit_rate),'순이익 ÷ 매출']];
  const dateValue=filters.start_date&&filters.end_date?[dayjs(filters.start_date),dayjs(filters.end_date)]:null;
  const cols=tab==='ledger'?12:10;
  return <div className="product-analytics-page">
    <header className="pa-header"><div><span className="pa-eyebrow">SHOPEE PRODUCT INTELLIGENCE</span><h1>상품 분석</h1><p>SKU 기준 국가별 판매 현황과 정산·FIFO 원가·순이익을 확인합니다.</p></div><span className="pa-period">{query.start_date} — {query.end_date}</span></header>
    <section className="pa-toolbar">
      <label className="pa-date-field">기간<div className="date-range-control"><RangePicker allowClear format="YYYY-MM-DD" value={dateValue} onChange={d=>setFilters(v=>({...v,start_date:d?.[0]?.format('YYYY-MM-DD')||'',end_date:d?.[1]?.format('YYYY-MM-DD')||''}))}/><QuickDateRangePicker dateFrom={filters.start_date} dateTo={filters.end_date} onSelect={r=>setFilters(v=>({...v,start_date:r.date_from,end_date:r.date_to}))}/></div></label>
      <label>국가<select value={filters.region} onChange={e=>setFilters(v=>({...v,region:e.target.value}))}><option value="">전체 국가</option><option>SG</option><option>MY</option><option>PH</option><option>TW</option></select></label>
      <label className="pa-search">상품 검색<input placeholder="SKU, 상품명, 옵션명" value={filters.search} onChange={e=>setFilters(v=>({...v,search:e.target.value}))} onKeyDown={e=>e.key==='Enter'&&apply()}/></label>
      <label>정렬<select value={`${filters.sort}:${filters.direction}`} onChange={e=>{const [sort,direction]=e.target.value.split(':');setFilters(v=>({...v,sort,direction}));}}>{SORTS.flatMap(([v,l])=>[<option key={`${v}:desc`} value={`${v}:desc`}>{l} 높은 순</option>,<option key={`${v}:asc`} value={`${v}:asc`}>{l} 낮은 순</option>])}</select></label>
      <button className="pa-primary" onClick={apply}>조회</button><button onClick={()=>{setFilters(initial);setQuery(initial);}}>초기화</button>
    </section>
    {error&&<div className="pa-alert error">{error}</div>}{(s.missing_cost_count>0||s.pending_settlement_orders>0)&&<div className="pa-alert"><b>확인할 항목</b>{s.missing_cost_count>0&&<span>원가 없는 상품 {num(s.missing_cost_count)}개</span>}{s.pending_settlement_orders>0&&<span>정산 대기 주문 {num(s.pending_settlement_orders)}건</span>}</div>}
    <div className="pa-kpis">{cards.map(([l,v,n],i)=><article key={l} className={i===6?'accent':''}><span>{l}</span><strong>{v}</strong><small>{n}</small></article>)}</div>
    <div className="pa-tabs"><button className={tab==='ledger'?'active':''} onClick={()=>setTab('ledger')}>상품 통합 원장</button><button className={tab==='performance'?'active':''} onClick={()=>setTab('performance')}>상품 성과 분석</button></div>
    {tab==='performance'&&chartRows.length>0&&<section className="pa-panel pa-chart"><div><h2>순이익 상위 상품</h2><p>현재 페이지의 상품을 실정산 기준으로 비교합니다.</p></div><ResponsiveContainer width="100%" height={260}><BarChart data={chartRows}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="label" tick={{fontSize:11}}/><YAxis tickFormatter={v=>`${Math.round(v/10000)}만`} tick={{fontSize:11}}/><Tooltip formatter={v=>won(v)}/><Bar dataKey="net_profit_krw" name="순이익" fill="#2563eb" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></section>}
    <section className="pa-panel"><div className="pa-panel-title"><div><h2>{tab==='ledger'?'상품 통합 원장':'상품별 성과'}</h2><p>상품명을 누르면 국가별 Shopee 상품 ID, 옵션 ID와 최근 주문을 확인할 수 있습니다.</p></div><span>{start.toLocaleString()}–{end.toLocaleString()} / 총 {num(data.total)}개 SKU</span></div>
      <div className="pa-table-wrap"><table><thead><tr><th className="pa-product-head">상품</th><th>SKU</th>{tab==='ledger'&&<><th>판매국가</th><SortHead field="stock_quantity" query={query} changeSort={changeSort}>재고</SortHead></>}<SortHead field="sold_qty" query={query} changeSort={changeSort}>판매수량</SortHead><SortHead field="order_count" query={query} changeSort={changeSort}>주문</SortHead><SortHead field="sales_krw" query={query} changeSort={changeSort}>매출</SortHead><SortHead field="settlement_krw" query={query} changeSort={changeSort}>정산</SortHead><SortHead field="cost_krw" query={query} changeSort={changeSort}>원가</SortHead><SortHead field="net_profit_krw" query={query} changeSort={changeSort}>순이익</SortHead><SortHead field="profit_rate" query={query} changeSort={changeSort}>이익률</SortHead><SortHead field="cancellation_rate" query={query} changeSort={changeSort}>취소율</SortHead></tr></thead><tbody>
      {loading?<tr><td colSpan={cols} className="pa-empty">불러오는 중입니다…</td></tr>:data.rows.length===0?<tr><td colSpan={cols} className="pa-empty">조건에 맞는 상품이 없습니다.</td></tr>:data.rows.map(row=><tr key={row.sku}><td><div className="pa-product">{row.image_url?<img src={row.image_url} alt=""/>:<span className="pa-no-image">NO IMAGE</span>}<button className="pa-product-link" onClick={()=>openDetail(row)}><b>{row.product_name_kr||row.item_name||row.product_name_en||'-'}</b><small>{row.option_name||'-'}</small></button></div></td><td><div className="pa-sku"><code>{row.sku}</code><button title="SKU 복사" onClick={()=>copySku(row.sku)}>복사</button></div></td>{tab==='ledger'&&<><td><div className="pa-tags">{String(row.regions||'').split(',').filter(Boolean).map(v=><span key={v}>{v}</span>)}</div></td><td><span className={row.stock_quantity<=0?'pa-stock bad':row.stock_quantity<5?'pa-stock warn':''}>{num(row.stock_quantity)}</span></td></>}<td>{num(row.sold_qty)}</td><td>{num(row.order_count)}</td><td>{won(row.sales_krw)}</td><td>{row.settlement_krw==null?<em>정산 대기</em>:won(row.settlement_krw)}</td><td>{won(row.cost_krw)}</td><td><span className={`pa-value ${profitTone(row.net_profit_krw)}`}>{row.net_profit_krw==null?'-':won(row.net_profit_krw)}</span></td><td><span className={`pa-rate ${marginTone(row.profit_rate)}`}>{pct(row.profit_rate)}</span></td><td><span className={`pa-rate ${cancelTone(row.cancellation_rate)}`}>{pct(row.cancellation_rate)}</span></td></tr>)}</tbody></table></div>
      <div className="pa-pagination"><span>{start.toLocaleString()}–{end.toLocaleString()} / {num(data.total)}</span><div><button disabled={data.page<=1} onClick={()=>go(1)}>«</button><button disabled={data.page<=1} onClick={()=>go(data.page-1)}>이전</button><b>{data.page} / {pages}</b><button disabled={data.page>=pages} onClick={()=>go(data.page+1)}>다음</button><button disabled={data.page>=pages} onClick={()=>go(pages)}>»</button></div></div>
    </section>
    {selected&&<div className="pa-modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&setSelected(null)}><section className="pa-detail"><header className="pa-detail-head"><div><span className="pa-eyebrow">SKU DETAIL</span><h2>{selected.product_name_kr||selected.item_name}</h2><p>{selected.option_name||'옵션 없음'}</p><div className="pa-detail-sku"><code>{selected.sku}</code><button onClick={()=>copySku(selected.sku)}>SKU 복사</button></div></div><button className="pa-close" aria-label="닫기" onClick={()=>setSelected(null)}>×</button></header>{!detail?<div className="pa-empty">상세 정보를 불러오는 중입니다…</div>:<><h3>국가별 판매 상품</h3>{detail.countries.length?<div className="pa-country-grid">{detail.countries.map((c,i)=><article key={`${c.region}-${c.shop_id}-${i}`}><b>{c.region}</b><span>Shopee 상품 ID <strong>{c.item_id||'-'}</strong></span><span>옵션 ID <strong>{c.option_id||'-'}</strong></span><span>판매 {num(c.sold_qty)}개 · 매출 {won(c.sales_krw)}</span><span>순이익 <strong className={profitTone(c.net_profit_krw)}>{won(c.net_profit_krw)}</strong></span></article>)}</div>:<div className="pa-empty compact">판매 국가 정보가 없습니다.</div>}<h3>최근 주문</h3><div className="pa-table-wrap small"><table><thead><tr><th>주문번호</th><th>국가</th><th>일시</th><th>수량</th><th>순이익</th></tr></thead><tbody>{detail.orders.slice(0,20).map((o,i)=><tr key={`${o.order_sn}-${i}`}><td>{o.order_sn}</td><td>{o.region}</td><td>{String(o.order_created_at||'').slice(0,10)}</td><td>{num(o.qty)}</td><td>{o.net_profit_krw==null?'정산 대기':won(o.net_profit_krw)}</td></tr>)}</tbody></table></div>{detail.batches?.length>0&&<><h3>FIFO 입고 배치</h3><div className="pa-batches">{detail.batches.map(b=><span key={b.id}>{String(b.received_at||'').slice(0,10)} · 잔여 {num(b.remaining_qty)} · {won(b.unit_cost)}</span>)}</div></>}</>}</section></div>}
    {notice&&<div className="pa-toast">{notice}</div>}
  </div>;
}
