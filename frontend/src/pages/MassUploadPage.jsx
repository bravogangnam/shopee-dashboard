import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

const DISPLAY_HEADERS = ['sku', '브랜드', '상품명', '옵션명', '상품설명', '대표이미지', '무게', '가격', '재고', '가로', '세로', '높이', '옵션이미지'];
const HEADER_ALIASES = { 브랜드:'brand',brand:'brand',상품명:'productName',productname:'productName',product_name:'productName',상품설명:'description',description:'description',대표이미지:'representativeImages',representativeimages:'representativeImages',representative_images:'representativeImages',옵션명:'optionName',optionname:'optionName',option_name:'optionName',sku:'sku',가격:'price',price:'price',재고:'stock',stock:'stock',무게:'weight',weight:'weight',가로:'length',length:'length',세로:'width',width:'width',높이:'height',height:'height',옵션이미지:'optionImage',optionimage:'optionImage',option_image:'optionImage' };
const INTERNAL_TO_DISPLAY = { sku:'sku', brand:'브랜드', productName:'상품명', optionName:'옵션명', description:'상품설명', representativeImages:'대표이미지', weight:'무게', price:'가격', stock:'재고', length:'가로', width:'세로', height:'높이', optionImage:'옵션이미지' };

const splitLine = (line) => line.includes('\t') ? line.split('\t').map((v) => v.trim()) : line.split(',').map((v) => v.trim());
const normalizeHeader = (v) => String(v || '').trim().replace(/\s+/g, '').toLowerCase();
const parseRep = (v) => String(v || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
const isNonEmptyRow = (row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== '');

function parseRows(headers, rows) {
  if (!Array.isArray(headers) || headers.length === 0 || !Array.isArray(rows) || rows.length === 0) return [];
  const keys = headers.map((h) => HEADER_ALIASES[normalizeHeader(h)] || null);
  const bucket = new Map();

  rows.forEach((cols, idx) => {
    if (!isNonEmptyRow(cols)) return;

    const row = {};
    keys.forEach((k, i) => { if (k) row[k] = String(cols?.[i] ?? '').trim(); });

    const hasAnyMappedValue = Object.values(row).some((v) => String(v || '').trim() !== '');
    if (!hasAnyMappedValue) return;

    const name = String(row.productName || '').trim() || `(상품명 없음 #${idx + 1})`;
    if (!bucket.has(name)) bucket.set(name, { id: `p_${Date.now()}_${idx}`, brand: row.brand || '', productName: name, description: row.description || '', representativeImages: parseRep(row.representativeImages), options: [] });

    const product = bucket.get(name);
    product.options.push({ optionName: String(row.optionName || '').trim() || 'Default', sku: row.sku || '', weight: row.weight || '', price: row.price || '', stock: row.stock || '', length: row.length || '', width: row.width || '', height: row.height || '', optionImage: row.optionImage || '' });
  });

  return Array.from(bucket.values());
}

function parseVisibleHeaders(headers) {
  if (!Array.isArray(headers) || headers.length === 0) return DISPLAY_HEADERS;
  const normalized = [];
  headers.forEach((header) => {
    const key = HEADER_ALIASES[normalizeHeader(header)] || null;
    if (!key) return;
    const display = INTERNAL_TO_DISPLAY[key];
    if (!display) return;
    if (!normalized.includes(display)) normalized.push(display);
  });
  return normalized.length ? normalized : DISPLAY_HEADERS;
}

function parseUploadText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { products: [], visibleHeaders: DISPLAY_HEADERS };
  const headers = splitLine(lines[0]);
  const rows = lines.slice(1).map(splitLine).filter(isNonEmptyRow);
  return { products: parseRows(headers, rows), visibleHeaders: parseVisibleHeaders(headers) };
}

function parseWorkbook(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) return { products: [], visibleHeaders: DISPLAY_HEADERS };
  const sheet = workbook.Sheets[firstSheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!Array.isArray(matrix) || matrix.length < 2) return { products: [], visibleHeaders: DISPLAY_HEADERS };
  const headers = (matrix[0] || []).map((v) => String(v || '').trim());
  const rows = matrix.slice(1).filter(isNonEmptyRow).map((row) => (Array.isArray(row) ? row : []));
  return { products: parseRows(headers, rows), visibleHeaders: parseVisibleHeaders(headers) };
}


function isLikelyRequiredHeader(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return text.includes('*') || /required|mandatory|필수/i.test(text);
}

function analyzeTemplateWorkbook(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetNames = workbook.SheetNames || [];

  const sheets = sheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    let bestHeaderRow = 0;
    let bestScore = -1;

    matrix.slice(0, 30).forEach((row, idx) => {
      const cells = Array.isArray(row) ? row.map((c) => String(c || '').trim()) : [];
      const nonEmpty = cells.filter(Boolean).length;
      const keywordScore = cells.filter((c) =>
        /product|sku|stock|price|brand|category|image|weight|variation|option|attribute|name|description|필수|상품|브랜드|가격|재고/i.test(c)
      ).length;
      const requiredScore = cells.filter(isLikelyRequiredHeader).length;
      const score = nonEmpty + keywordScore * 2 + requiredScore * 3;

      if (score > bestScore) {
        bestScore = score;
        bestHeaderRow = idx;
      }
    });

    const headers = (matrix[bestHeaderRow] || []).map((c) => String(c || '').trim());
    const requiredColumns = headers
      .map((h, idx) => ({ index: idx + 1, header: h }))
      .filter((x) => isLikelyRequiredHeader(x.header));

    const mappingCandidates = headers
      .map((header, idx) => {
        const key = normalizeHeader(header);
        const internal = HEADER_ALIASES[key] || null;
        return internal ? { templateColumn: idx + 1, templateHeader: header, internalField: internal } : null;
      })
      .filter(Boolean);

    return {
      sheetName,
      rowCount: matrix.length,
      headerRow: bestHeaderRow + 1,
      dataStartRow: bestHeaderRow + 2,
      headerCount: headers.filter(Boolean).length,
      headers: headers.filter(Boolean).slice(0, 80),
      requiredColumns,
      mappingCandidates,
    };
  });

  return { sheetNames, sheets };
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
  const [visibleHeaders, setVisibleHeaders] = useState(DISPLAY_HEADERS);
  const [templateFile, setTemplateFile] = useState(null);
  const [templateAnalysis, setTemplateAnalysis] = useState(null);
  const [templateMessage, setTemplateMessage] = useState('');

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
    const fileName = String(selectedFile.name || '').toLowerCase();
    const reader = new FileReader();

    if (fileName.endsWith('.xlsx')) {
      reader.onload = () => {
        const { products: nextProducts, visibleHeaders: nextVisibleHeaders } = parseWorkbook(reader.result);
        setProducts(nextProducts);
        setVisibleHeaders(nextVisibleHeaders);
        setMessage('xlsx 파일 읽기 완료');
      };
      reader.readAsArrayBuffer(selectedFile);
      return;
    }

    reader.onload = () => {
      const { products: nextProducts, visibleHeaders: nextVisibleHeaders } = parseUploadText(String(reader.result || ''));
      setProducts(nextProducts);
      setVisibleHeaders(nextVisibleHeaders);
      setMessage('파일 읽기 완료');
    };
    reader.readAsText(selectedFile);
  };

  const runKrscPrepare = async () => {
    setMetaResults([]);
    setMessage('KRSC 템플릿 매핑 준비 중...');
    const body = { products: products.map((p) => ({ productKey: p.id, productName: p.productName, description: p.description || p.productName, brand: p.brand, optionCount: p.options.length })) };
    try {
      const res = await fetch('/api/shopee-meta/mass-upload/krsc-prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) { setMessage(data.message || 'KRSC 매핑 준비 실패'); return; }
      const resultProducts = Array.isArray(data.products)
        ? data.products
        : Array.isArray(data.data?.products)
          ? data.data.products
          : Array.isArray(data.result?.products)
            ? data.result.products
            : [];

      setMetaResults(resultProducts);
      setMessage(`KRSC 템플릿 매핑 준비 완료: ${resultProducts.length}건`);
    } catch {
      setMessage('KRSC 템플릿 매핑 준비 실패');
    }
  };


  const analyzeTemplateFile = async () => {
    if (!templateFile) {
      setTemplateMessage('공식 템플릿 파일을 선택하세요.');
      return;
    }

    try {
      setTemplateMessage('공식 템플릿 분석 중...');
      const buffer = await templateFile.arrayBuffer();
      const analysis = analyzeTemplateWorkbook(buffer);
      setTemplateAnalysis(analysis);
      setTemplateMessage(`공식 템플릿 분석 완료: 시트 ${analysis.sheetNames.length}개`);
    } catch (err) {
      setTemplateAnalysis(null);
      setTemplateMessage(`공식 템플릿 분석 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>대량등록</h1>
        <p>등록용 엑셀을 업로드하면 Shopee 공식 템플릿 생성용 데이터로 검증합니다.</p>
        <p><strong>기준: KRSC 글로벌 프로덕트 대량등록</strong></p>
      </header>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>파일 업로드</h2>
        <p>지원 파일: .xlsx, .csv, .tsv, .txt</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ border: '1px solid #ddd', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}>
            파일 선택
            <input type="file" accept=".xlsx,.csv,.tsv,.txt" style={{ display: 'none' }} onChange={(e) => setSelectedFile(e.target.files?.[0] || null)} />
          </label>
          <button type="button" onClick={readSelectedFile}>등록용 엑셀 읽기</button>
          <button type="button" onClick={() => {
            const { products: nextProducts, visibleHeaders: nextVisibleHeaders } = parseUploadText(pasteText);
            setProducts(nextProducts);
            setVisibleHeaders(nextVisibleHeaders);
            setMessage('붙여넣기 적용 완료');
          }}>
            붙여넣기 적용
          </button>
          <button type="button" onClick={() => { setProducts([]); setMetaResults([]); setPasteText(''); setVisibleHeaders(DISPLAY_HEADERS); setSelectedFile(null); setTemplateFile(null); setTemplateAnalysis(null); setTemplateMessage(''); setMessage('초기화되었습니다.'); }}>초기화</button>
        </div>
        {selectedFile ? (
          <p style={{ marginTop: 8 }}>선택된 파일: {selectedFile.name}</p>
        ) : (
          <p style={{ marginTop: 8 }}>선택된 파일이 없습니다.</p>
        )}
        {message && !message.startsWith('KRSC') ? <p style={{ marginTop: 4 }}>{message}</p> : null}
        <details style={{ marginTop: 8 }}>
          <summary>붙여넣기 입력 열기</summary>
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
            <tr>{visibleHeaders.map((h) => <th key={h} style={{ borderBottom: '1px solid #ddd', padding: 6 }}>{h}</th>)}<th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>상태</th></tr>
          </thead>
          <tbody>
            {displayRows.map((r, idx) => { const b = badge(r.status); return <tr key={idx}>{visibleHeaders.map((h) => <td key={h} style={{ borderBottom: '1px solid #eee', padding: 6 }}><input value={r[h] || ''} readOnly style={{ minWidth: 100 }} /></td>)}<td style={{ borderBottom: '1px solid #eee', padding: 6 }}><span style={{ padding: '2px 8px', borderRadius: 999, ...b.style }}>{b.text}</span></td></tr>; })}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>4. KRSC 글로벌 상품정보 매핑 준비</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={runKrscPrepare}>KRSC 템플릿 매핑 준비</button>
          <span>Days to ship: 1 고정</span>
        </div>
        {message && message.startsWith('KRSC') ? (
          <p style={{ marginTop: 8 }}>{message}</p>
        ) : null}
        <div style={{ marginTop: 10 }}>
          {metaResults.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <h3>KRSC 매핑 결과 {metaResults.length}건</h3>
              {metaResults.map((p) => (
                <div key={p.productKey || p.productName} style={{ border: '1px solid #eee', padding: 10, marginBottom: 8 }}>
                  <div><strong>{p.productName}</strong> | 옵션 {p.optionCount} | 상태 {p.status}</div>
                  <div>KRSC category_id: {p.category?.categoryId || '-'} / {p.category?.categoryPath || p.category?.categoryName || '-'}</div>
                  <div>category source: {p.category?.source || '-'} / {p.category?.confidence || '-'}</div>
                  <div>used item name: {p.category?.usedItemName || '-'}</div>
                  <div>brand: {p.brand?.brandName || '-'} / brand_id: {p.brand?.brandId ?? '-'}</div>
                  <div>brand status: {p.brand?.matchStatus || '-'}</div>
                  <div>필수항목: 공식 템플릿 분석 전</div>
                  {(p.requiredAttributes || []).length > 0 ? (
                    <div style={{ marginTop: 4 }}>
                      {(p.requiredAttributes || []).slice(0, 12).map((a, idx) => (
                        <span key={`${a.attributeId || a.attributeName || idx}`} style={{ display: 'inline-block', marginRight: 6, marginBottom: 4, padding: '2px 6px', border: '1px solid #ddd', borderRadius: 6 }}>
                          {a.attributeName || a.attributeId}
                        </span>
                      ))}
                      {(p.requiredAttributes || []).length > 12 ? <span>외 {(p.requiredAttributes || []).length - 12}개</span> : null}
                    </div>
                  ) : null}
                  <div>공식 템플릿: category_id별 공식 템플릿 업로드 필요</div>
                  <div>Days to ship: {p.daysToShip || 1}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>5. 공식 템플릿 업로드 / 매핑 분석</h2>
        <p>
          KRSC 대량등록은 category_id별 공식 Excel 템플릿이 기준입니다.
          공식 템플릿을 업로드하면 시트/헤더행/데이터 시작행/필수 컬럼 후보/매핑 후보를 분석합니다.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ border: '1px solid #ddd', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}>
            공식 템플릿 선택
            <input
              type="file"
              accept=".xlsx"
              style={{ display: 'none' }}
              onChange={(e) => {
                setTemplateFile(e.target.files?.[0] || null);
                setTemplateAnalysis(null);
                setTemplateMessage('');
              }}
            />
          </label>
          <button type="button" onClick={analyzeTemplateFile}>공식 템플릿 분석</button>
          <button type="button" disabled>엑셀 생성 준비중</button>
        </div>

        <p style={{ marginTop: 8 }}>
          {templateFile ? `선택된 공식 템플릿: ${templateFile.name}` : '선택된 공식 템플릿이 없습니다.'}
        </p>
        {templateMessage ? <p>{templateMessage}</p> : null}

        {templateAnalysis ? (
          <div style={{ marginTop: 12 }}>
            <h3>템플릿 분석 결과</h3>
            <div>시트: {templateAnalysis.sheetNames.join(', ') || '-'}</div>
            {templateAnalysis.sheets.map((sheet) => (
              <div key={sheet.sheetName} style={{ border: '1px solid #eee', padding: 10, marginTop: 8 }}>
                <div><strong>{sheet.sheetName}</strong></div>
                <div>헤더 행 추정: {sheet.headerRow}</div>
                <div>데이터 시작 행 추정: {sheet.dataStartRow}</div>
                <div>헤더 수: {sheet.headerCount}</div>
                <div>필수 컬럼 후보: {sheet.requiredColumns.length}</div>
                {sheet.requiredColumns.length > 0 ? (
                  <div style={{ marginTop: 4 }}>
                    {sheet.requiredColumns.slice(0, 20).map((c) => (
                      <span key={`${sheet.sheetName}-${c.index}`} style={{ display: 'inline-block', marginRight: 6, marginBottom: 4, padding: '2px 6px', border: '1px solid #ddd', borderRadius: 6 }}>
                        {c.header}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div style={{ marginTop: 6 }}>매핑 후보: {sheet.mappingCandidates.length}</div>
                {sheet.mappingCandidates.length > 0 ? (
                  <div style={{ marginTop: 4 }}>
                    {sheet.mappingCandidates.slice(0, 20).map((m) => (
                      <span key={`${sheet.sheetName}-${m.templateColumn}-${m.internalField}`} style={{ display: 'inline-block', marginRight: 6, marginBottom: 4, padding: '2px 6px', border: '1px solid #ddd', borderRadius: 6 }}>
                        {m.templateHeader} → {m.internalField}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
