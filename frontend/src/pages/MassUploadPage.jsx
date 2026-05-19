import { useMemo, useState } from 'react';

const DISPLAY_HEADERS = ['sku', '브랜드', '상품명', '옵션명', '상품설명', '대표이미지', '무게', '가격', '재고', '가로', '세로', '높이', '옵션이미지'];
const HEADER_ALIASES = { 브랜드:'brand',brand:'brand',상품명:'productName',productname:'productName',product_name:'productName',상품설명:'description',description:'description',대표이미지:'representativeImages',representativeimages:'representativeImages',representative_images:'representativeImages',옵션명:'optionName',optionname:'optionName',option_name:'optionName',sku:'sku',가격:'price',price:'price',재고:'stock',stock:'stock',무게:'weight',weight:'weight',가로:'length',length:'length',세로:'width',width:'width',높이:'height',height:'height',옵션이미지:'optionImage',optionimage:'optionImage',option_image:'optionImage' };

const splitLine = (line) => line.includes('\t') ? line.split('\t').map((v) => v.trim()) : line.split(',').map((v) => v.trim());
const normalizeHeader = (v) => String(v || '').trim().replace(/\s+/g, '').toLowerCase();
const parseRep = (v) => String(v || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

function parseUploadText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]);
  const keys = headers.map((h) => HEADER_ALIASES[normalizeHeader(h)] || null);
  const rows = lines.slice(1).map(splitLine);
  const bucket = new Map();
  rows.forEach((cols, idx) => {
    const row = {};
    keys.forEach((k, i) => { if (k) row[k] = cols[i] || ''; });
    const name = String(row.productName || '').trim() || `(상품명 없음 #${idx + 1})`;
    if (!bucket.has(name)) bucket.set(name, { id: `p_${Date.now()}_${idx}`, brand: row.brand || '', productName: name, description: row.description || '', representativeImages: parseRep(row.representativeImages), options: [] });
    const p = bucket.get(name);
    p.options.push({ optionName: String(row.optionName || '').trim() || 'Default', sku: row.sku || '', weight: row.weight || '', price: row.price || '', stock: row.stock || '', length: row.length || '', width: row.width || '', height: row.height || '', optionImage: row.optionImage || '' });
  });
  return Array.from(bucket.values());
}

function validateProduct(product) {
  const errors = []; const reviews = [];
  if (!String(product.productName || '').trim()) errors.push('상품명 필수');
  if (!String(product.description || '').trim()) reviews.push('상품설명 없음');
  if ((product.representativeImages || []).length === 0) reviews.push('대표이미지 없음');
  if ((product.representativeImages || []).length > 9) errors.push('대표이미지 9장 초과');
  const anyImg = (product.options || []).some((o) => String(o.optionImage || '').trim());
  if (anyImg && (product.options || []).some((o) => !String(o.optionImage || '').trim())) errors.push('옵션이미지 일부 누락');
  (product.options || []).forEach((o, idx) => {
    const p = `옵션 ${idx + 1}`;
    if (!String(o.sku || '').trim()) errors.push(`${p}: sku 필수`);
    ['price', 'stock', 'weight'].forEach((f) => { if (!String(o[f] || '').trim()) errors.push(`${p}: ${f} 필수`); });
  });
  return { status: errors.length ? 'error' : (reviews.length ? 'review' : 'ready') };
}

const badge = (s) => s === 'ready' ? { text: '준비 완료', style: { background: '#e8f7ed', color: '#1b7f3b' } } : s === 'review' ? { text: '검수 필요', style: { background: '#fff7e8', color: '#a46300' } } : { text: '오류', style: { background: '#fdecec', color: '#b42318' } };

export default function MassUploadPage() {
  const [products, setProducts] = useState([]);
  const [pasteText, setPasteText] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [message, setMessage] = useState('');
  const [metaResults, setMetaResults] = useState([]);

  const displayRows = useMemo(() => {
    const out = [];
    products.forEach((p, pi) => {
      const v = validateProduct(p);
      p.options.forEach((o, oi) => out.push({
        productIndex: pi, optionIndex: oi,
        sku: o.sku, 브랜드: p.brand, 상품명: p.productName, 옵션명: o.optionName,
        상품설명: oi === 0 ? p.description : '', 대표이미지: oi === 0 ? (p.representativeImages || []).join('\n') : '',
        무게: o.weight, 가격: o.price, 재고: o.stock, 가로: o.length, 세로: o.width, 높이: o.height, 옵션이미지: o.optionImage,
        status: v.status,
      }));
    });
    return out;
  }, [products]);

  const summary = useMemo(() => {
    const out = { products: products.length, options: 0, ready: 0, review: 0, error: 0 };
    products.forEach((p) => { const v = validateProduct(p); out.options += p.options.length; out[v.status] += 1; });
    return out;
  }, [products]);

  const readSelectedFile = () => {
    if (!selectedFile) { setMessage('파일을 먼저 선택하세요.'); return; }
    const r = new FileReader();
    r.onload = () => { setProducts(parseUploadText(String(r.result || ''))); setMessage('파일 읽기 완료'); };
    r.readAsText(selectedFile);
  };

  const runKrscPrepare = async () => {
    const body = { products: products.map((p) => ({ productKey: p.id, productName: p.productName, description: p.description || p.productName, brand: p.brand, optionCount: p.options.length })) };
    try {
      const res = await fetch('/api/shopee-meta/mass-upload/krsc-prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) { setMessage(data.message || 'KRSC 매핑 준비 실패'); return; }
      setMetaResults(data.products || []);
      setMessage('KRSC 템플릿 매핑 준비 완료');
    } catch {
      setMessage('KRSC 템플릿 매핑 준비 실패');
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>대량등록</h1>
        <p>등록용 엑셀을 업로드하면 Shopee 공식 템플릿 생성용 데이터로 검증합니다.</p>
        <p><strong>기준: KRSC 글로벌 필로덕트 대량등록</strong></p>
      </header>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>파일 업로드</h2>
        <p>지원 파일: .csv, .tsv, .txt</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ border: '1px solid #ddd', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}>
            파일 선택
            <input type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} onChange={(e) => setSelectedFile(e.target.files?.[0] || null)} />
          </label>
          <button type="button" onClick={readSelectedFile}>등록용 엑셀 읽기</button>
          <button type="button" onClick={() => { setProducts(parseUploadText(pasteText)); setMessage('붙여넣기 적용 완료'); }}>붙여넣기 적용</button>
          <button type="button" onClick={() => { setProducts([]); setMetaResults([]); setPasteText(''); setMessage('초기화되었습니다.'); }}>초기화</button>
        </div>
        <p style={{ marginTop: 8 }}>{message || '선택된 파일이 없습니다.'}</p>
        <details style={{ marginTop: 8 }}>
          <summary>붙여넣기 입력 열긠</summary>
          <textarea rows={4} value={pasteText} onChange={(e) => setPasteText(e.target.value)} style={{ width: '100%' }} />
        </details>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>요약</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>상품 수 {summary.products}</span><span>옵션 수 {summary.options}</span><span>준비 완료 {summary.ready}</span><span>검수 필요 {summary.review}</span><span>오류 {summary.error}</span>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16, overflowX: 'auto' }}>
        <h2>등록용 엑셀 테이블</h2>
        <table style={{ width: '100%', minWidth: 1300, borderCollapse: 'collapse' }}>
          <thead>
            <tr>{DISPLAY_HEADERS.map((h) => <th key={h} style={{ borderBottom: '1px solid #ddd', padding: 6 }}>{h}</th>)}<th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>상태</th></tr>
          </thead>
          <tbody>
            {displayRows.map((r, idx) => { const b = badge(r.status); return <tr key={idx}>{DISPLAY_HEADERS.map((h) => <td key={h} style={{ borderBottom: '1px solid #eee', padding: 6 }}><input value={r[h] || ''} readOnly style={{ minWidth: 100 }} /></td>)}<td style={{ borderBottom: '1px solid #eee', padding: 6 }}><span style={{ padding: '2px 8px', borderRadius: 999, ...b.style }}>{b.text}</span></td></tr>; })}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>4. KRSC 글로벌 상품정보 매핑 준비</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={runKrscPrepare}>KRSC 템플릿 매핑 준비</button>
          <span>Days to ship: 1 고정</span>
        </div>
        <div style={{ marginTop: 10 }}>
          {metaResults.map((p) => <div key={p.productKey} style={{ border: '1px solid #eee', padding: 10, marginBottom: 8 }}><div><strong>{p.productName}</strong> | 옵션 {p.optionCount} | 상태 {p.status}</div><div>KRSC category_id: {p.category?.categoryId || '-'} / {p.category?.categoryPath || '-'}</div><div>brand: {p.brand?.brandName || '-'}</div><div>필수항목: {(p.requiredAttributes || []).length}</div><div>Days to ship: {p.daysToShip || 1}</div></div>)}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>다음 단계 준비중</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled>공식 템플릿 매핑 준비중</button>
          <button type="button" disabled>엑셀 생성 준비중</button>
        </div>
      </section>
    </div>
  );
}
