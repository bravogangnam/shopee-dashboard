import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

const COLUMNS = [
  ['sku', 'sku', 130],
  ['brand', '브랜드', 120],
  ['productName', '상품명', 240],
  ['optionName', '옵션명', 150],
  ['description', '상품설명', 300],
  ['representativeImages', '대표이미지', 300],
  ['weight', '무게', 90],
  ['price', '가격', 100],
  ['stock', '재고', 80],
  ['length', '가로', 80],
  ['width', '세로', 80],
  ['height', '높이', 80],
  ['optionImage', '옵션이미지', 260],
];

const ALIASES = {
  sku: ['sku', 'SKU', '판매자SKU', 'sellerSku', 'seller_sku'],
  brand: ['브랜드', 'brand'],
  productName: ['상품명', 'productName', 'product_name', 'product name', 'name'],
  optionName: ['옵션명', 'optionName', 'option_name', 'option name', 'variationName', 'variation_name'],
  description: ['상품설명', 'description', 'productDescription', 'product_description', 'product description'],
  representativeImages: ['대표이미지', '대표이미지URL', '대표이미지 URL', '대표이미지목록', '이미지', '이미지1', '이미지2', '이미지3', '이미지4', '이미지5', '이미지6', '이미지7', '이미지8', '이미지9', 'representativeImages', 'representative_images', 'mainImages', 'main_images', 'images', 'image'],
  weight: ['무게', 'weight'],
  price: ['가격', 'price'],
  stock: ['재고', 'stock', 'qty', 'quantity'],
  length: ['가로', 'length'],
  width: ['세로', 'width'],
  height: ['높이', 'height'],
  optionImage: ['옵션이미지', '옵션이미지URL', '옵션이미지 URL', 'optionImage', 'option_image', 'variationImage', 'variation_image'],
};

const STATUS_LABELS = { Ready: '준비 완료', 'Review Required': '검수 필요', Error: '오류' };
const EMPTY_ROW = { sku: '', brand: 'No Brand', productName: '', optionName: 'Default', description: '', representativeImages: '', weight: '', price: '', stock: '', length: '', width: '', height: '', optionImage: '' };

function normalize(value) {
  return String(value || '').trim().replace(/[\s_\-]/g, '').toLowerCase();
}

function fieldForHeader(header) {
  const key = normalize(header);
  return Object.entries(ALIASES).find(([, aliases]) => aliases.some((name) => normalize(name) === key))?.[0] || '';
}

function splitImages(value) {
  return String(value || '').split(/[\r\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function splitTextLine(line, delimiter) {
  return String(line || '').split(delimiter).map((cell) => cell.trim());
}

function isNumberLike(value) {
  const text = String(value || '').trim();
  return text !== '' && Number.isFinite(Number(text));
}

function makeRowsFromMatrix(matrix) {
  const clean = matrix.filter((row) => row.some((cell) => String(cell || '').trim()));
  if (clean.length < 2) return { rows: [], message: '헤더와 데이터 행이 필요합니다.' };

  const headers = clean[0].map((cell) => String(cell || '').trim());
  const fields = headers.map(fieldForHeader);
  if (!fields.some(Boolean)) return { rows: [], message: '인식 가능한 헤더가 없습니다.' };

  const rows = clean.slice(1).map((cells) => {
    const row = { ...EMPTY_ROW };
    fields.forEach((field, index) => {
      if (!field) return;
      const value = String(cells[index] ?? '').trim();
      if (field === 'representativeImages' && row.representativeImages && value) row.representativeImages += `\n${value}`;
      else if (value || field !== 'brand') row[field] = value;
    });
    if (!row.brand) row.brand = 'No Brand';
    if (!row.optionName) row.optionName = 'Default';
    return row;
  });

  return { rows, message: `${rows.length}개 행을 불러왔습니다.` };
}

function parseText(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  const delimiter = lines[0]?.includes('\t') ? '\t' : ',';
  return makeRowsFromMatrix(lines.map((line) => splitTextLine(line, delimiter)));
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], message: '엑셀 시트를 찾지 못했습니다.' };
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  return makeRowsFromMatrix(matrix);
}

function analyzeRows(rows) {
  const products = new Map();

  rows.forEach((row) => {
    const key = String(row.productName || '').trim() || '상품명 없음';
    if (!products.has(key)) products.set(key, []);
    products.get(key).push(row);
  });

  const rowStates = rows.map((row) => {
    const errors = [];
    const reviews = [];

    if (!row.productName.trim()) errors.push('상품명 필수');
    if (!row.sku.trim()) errors.push('SKU 필수');

    if (!row.price.trim()) errors.push('가격 필수');
    else if (!isNumberLike(row.price)) errors.push('가격 숫자 오류');

    if (!row.stock.trim()) errors.push('재고 필수');
    else if (!isNumberLike(row.stock)) errors.push('재고 숫자 오류');

    if (!row.weight.trim()) errors.push('무게 필수');
    else if (!isNumberLike(row.weight)) errors.push('무게 숫자 오류');

    [['length', '가로'], ['width', '세로'], ['height', '높이']].forEach(([field, label]) => {
      if (row[field].trim() && !isNumberLike(row[field])) errors.push(`${label} 숫자 오류`);
    });

    return errors.length
      ? { status: 'Error', messages: errors }
      : reviews.length
      ? { status: 'Review Required', messages: reviews }
      : { status: 'Ready', messages: ['준비 완료'] };
  });

  products.forEach((groupRows) => {
    const groupDescriptionExists = groupRows.some((row) => String(row.description || '').trim());
    const groupImages = groupRows.flatMap((row) => splitImages(row.representativeImages));
    const uniqueImageCount = new Set(groupImages).size;

    const optionImageCount = groupRows.filter((row) => row.optionImage.trim()).length;
    const groupMessages = [];
    const groupErrors = [];

    if (!groupDescriptionExists) groupMessages.push('상품설명 확인 필요');
    if (uniqueImageCount === 0) groupMessages.push('대표이미지 확인 필요');
    if (uniqueImageCount > 9) groupErrors.push('대표이미지는 최대 9장');

    if (optionImageCount > 0 && optionImageCount !== groupRows.length) {
      groupErrors.push('옵션이미지는 모든 옵션에 필요');
    }

    if (!groupMessages.length && !groupErrors.length) return;

    groupRows.forEach((row) => {
      const index = rows.indexOf(row);
      const current = rowStates[index];

      if (groupErrors.length || current.status === 'Error') {
        rowStates[index] = {
          status: 'Error',
          messages: [...current.messages, ...groupErrors],
        };
        return;
      }

      rowStates[index] = {
        status: 'Review Required',
        messages: [...current.messages.filter((message) => message !== '준비 완료'), ...groupMessages],
      };
    });
  });

  const summary = rowStates.reduce((acc, item) => {
    acc[item.status] += 1;
    return acc;
  }, { Ready: 0, 'Review Required': 0, Error: 0 });

  return { productCount: products.size, optionCount: rows.length, rowStates, summary };
}

function StatusBadge({ status }) {
  const color = status === 'Ready' ? ['#15803d', '#dcfce7'] : status === 'Error' ? ['#b91c1c', '#fee2e2'] : ['#b45309', '#fef3c7'];
  return <span style={{ color: color[0], background: color[1], borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 }}>{STATUS_LABELS[status]}</span>;
}

function SummaryCard({ title, value, tone }) {
  const colors = { blue: ['#eff6ff', '#bfdbfe'], green: ['#f0fdf4', '#bbf7d0'], yellow: ['#fffbeb', '#fde68a'], red: ['#fef2f2', '#fecaca'] };
  const [background, border] = colors[tone] || colors.blue;
  return <div style={{ border: `1px solid ${border}`, background, borderRadius: 12, padding: 12 }}><div style={{ fontSize: 12, color: '#6b7280' }}>{title}</div><strong style={{ fontSize: 20 }}>{value}</strong></div>;
}

export default function MassUploadPage() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [pasteText, setPasteText] = useState('');
  const [rows, setRows] = useState([{ ...EMPTY_ROW }]);
  const [message, setMessage] = useState('등록용 엑셀을 선택한 뒤 “등록용 엑셀 읽기”를 누르세요.');
  const fileRef = useRef(null);
  const analysis = useMemo(() => analyzeRows(rows), [rows]);

  const loadResult = (result) => {
    if (!result.rows.length) {
      setMessage(result.message);
      return;
    }
    setRows(result.rows);
    setMessage(result.message);
  };

  const readSelectedFile = () => {
    if (!selectedFile) {
      setMessage('파일을 먼저 선택하세요.');
      return;
    }
    const reader = new FileReader();
    const isXlsx = selectedFile.name.toLowerCase().endsWith('.xlsx');
    reader.onload = () => {
      try {
        loadResult(isXlsx ? parseWorkbook(reader.result) : parseText(String(reader.result || '')));
      } catch (error) {
        setMessage(`파일 읽기 실패: ${error.message}`);
      }
    };
    if (isXlsx) reader.readAsArrayBuffer(selectedFile);
    else reader.readAsText(selectedFile, 'utf-8');
  };

  const updateCell = (rowIndex, field, value) => {
    setRows((prev) => prev.map((row, index) => index === rowIndex ? { ...row, [field]: value } : row));
  };

  const clearAll = () => {
    setSelectedFile(null);
    setPasteText('');
    setRows([{ ...EMPTY_ROW }]);
    setMessage('초기화되었습니다.');
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>대량등록</h1>
        <p>등록용 엑셀을 업로드하면 Shopee 공식 템플릿 생성용 데이터로 검증합니다.</p>
      </header>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>1. 등록용 엑셀 업로드</h2>
        <p style={{ color: '#6b7280' }}>지원 파일: .xlsx, .csv, .tsv, .txt / 첫 행은 헤더로 사용합니다.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={(event) => { setSelectedFile(event.target.files?.[0] || null); setMessage(event.target.files?.[0]?.name ? `${event.target.files[0].name} 선택됨` : '파일 선택 취소'); }} />
          <button type="button" onClick={readSelectedFile}>등록용 엑셀 읽기</button>
          <button type="button" onClick={() => loadResult(parseText(pasteText))}>붙여넣기 적용</button>
          <button type="button" onClick={clearAll}>초기화</button>
        </div>
        <details style={{ marginTop: 12 }}>
          <summary>엑셀에서 복사해서 붙여넣기</summary>
          <textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder="헤더 포함 범위를 복사해서 붙여넣으세요." style={{ width: '100%', minHeight: 110, border: '1px solid #d1d5db', borderRadius: 10, padding: 10, marginTop: 8, fontFamily: 'monospace' }} />
        </details>
        <div style={{ marginTop: 8, color: '#6b7280' }}>{message}</div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>2. 업로드 결과 요약</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <SummaryCard title="상품 수" value={analysis.productCount} tone="blue" />
          <SummaryCard title="옵션 수" value={analysis.optionCount} tone="blue" />
          <SummaryCard title="준비 완료" value={analysis.summary.Ready} tone="green" />
          <SummaryCard title="검수 필요" value={analysis.summary['Review Required']} tone="yellow" />
          <SummaryCard title="오류" value={analysis.summary.Error} tone="red" />
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>3. 등록용 엑셀 테이블</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 1850, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>상태</th>
                {COLUMNS.map(([, label]) => <th key={label} style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const state = analysis.rowStates[rowIndex] || { status: 'Error', messages: ['검증 실패'] };
                return <tr key={`row-${rowIndex}`}>
                  <td style={{ padding: 6, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top', width: 160 }}><StatusBadge status={state.status} /><div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{state.messages.join(', ')}</div></td>
                  {COLUMNS.map(([field, , width]) => <td key={field} style={{ padding: 6, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}><input value={row[field] || ''} onChange={(event) => updateCell(rowIndex, field, event.target.value)} style={{ width, border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 9px' }} /></td>)}
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>4. 다음 단계 준비중</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled>카테고리 자동 추천 준비중</button>
          <button type="button" disabled>공식 템플릿 매핑 준비중</button>
          <button type="button" disabled>엑셀 생성 준비중</button>
        </div>
      </section>
    </div>
  );
}
