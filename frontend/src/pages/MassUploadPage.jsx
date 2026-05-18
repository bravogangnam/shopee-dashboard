import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

const OPTION_FIELDS = [
  ['optionName', '옵션명', 150],
  ['sku', 'SKU', 160],
  ['price', '가격', 100],
  ['stock', '재고', 90],
  ['weight', '무게', 90],
  ['length', '가로', 90],
  ['width', '세로', 90],
  ['height', '높이', 90],
  ['optionImage', '옵션이미지 URL', 260],
];

const STATUS_LABELS = { Ready: '준비 완료', 'Review Required': '검수 필요', Error: '오류' };
const EMPTY_OPTION = { optionName: 'Default', sku: '', price: '', stock: '', weight: '', length: '', width: '', height: '', optionImage: '' };
const EMPTY_PRODUCT = { brand: 'No Brand', productName: '', description: '', representativeImagesText: '', options: [EMPTY_OPTION] };

const ALIASES = {
  brand: ['브랜드', 'brand'],
  productName: ['상품명', 'productname', 'product_name', 'product name', 'name'],
  description: ['상품설명', 'description', 'productdescription', 'product_description', 'product description'],
  representativeImages: ['대표이미지', '대표이미지목록', '대표이미지url', '대표이미지 url', '이미지', '이미지1', '이미지2', '이미지3', '이미지4', '이미지5', '이미지6', '이미지7', '이미지8', '이미지9', 'representativeimages', 'representative_images', 'images', 'image'],
  optionName: ['옵션명', 'optionname', 'option_name', 'option name', 'variationname', 'variation_name'],
  sku: ['sku', '판매자sku', 'sellersku', 'seller_sku'],
  price: ['가격', 'price'],
  stock: ['재고', 'stock', 'qty', 'quantity'],
  weight: ['무게', 'weight'],
  length: ['가로', 'length'],
  width: ['세로', 'width'],
  height: ['높이', 'height'],
  optionImage: ['옵션이미지', '옵션이미지url', '옵션이미지 url', 'optionimage', 'option_image', 'variationimage', 'variation_image'],
};

function emptyOption() {
  return { ...EMPTY_OPTION };
}

function emptyProduct() {
  return { ...EMPTY_PRODUCT, options: [emptyOption()] };
}

function norm(value) {
  return String(value || '').trim().replace(/[\s_\-]/g, '').toLowerCase();
}

function fieldForHeader(header) {
  const target = norm(header);
  return Object.entries(ALIASES).find(([, names]) => names.some((name) => norm(name) === target))?.[0] || '';
}

function imageList(text) {
  return String(text || '').split(/[\r\n,;]+/).map((v) => v.trim()).filter(Boolean);
}

function numberOk(value) {
  const text = String(value || '').trim();
  return text !== '' && Number.isFinite(Number(text));
}

function splitRow(line, delimiter) {
  return String(line || '').split(delimiter).map((cell) => cell.trim());
}

function parseUploadRows(headers, dataRows) {
  const fields = headers.map(fieldForHeader);
  if (!fields.some(Boolean)) return { products: [], message: '인식 가능한 헤더가 없습니다.' };

  const groups = new Map();

  dataRows.forEach((cells, index) => {
    const row = {};
    const representativeImages = [];

    fields.forEach((field, cellIndex) => {
      if (!field) return;
      const value = String(cells[cellIndex] ?? '').trim();
      if (field === 'representativeImages') representativeImages.push(...imageList(value));
      else row[field] = value;
    });

    const key = String(row.productName || '').trim() || `상품명 없음 ${index + 1}`;

    if (!groups.has(key)) {
      groups.set(key, {
        brand: row.brand || 'No Brand',
        productName: row.productName || '',
        description: row.description || '',
        representativeImagesText: representativeImages.join('
'),
        options: [],
      });
    }

    const product = groups.get(key);
    if (!product.description && row.description) product.description = row.description;
    if (!product.brand && row.brand) product.brand = row.brand;

    if (representativeImages.length) {
      const merged = new Set(imageList(product.representativeImagesText));
      representativeImages.forEach((image) => merged.add(image));
      product.representativeImagesText = Array.from(merged).join('
');
    }

    product.options.push({
      optionName: row.optionName || 'Default',
      sku: row.sku || '',
      price: row.price || '',
      stock: row.stock || '',
      weight: row.weight || '',
      length: row.length || '',
      width: row.width || '',
      height: row.height || '',
      optionImage: row.optionImage || '',
    });
  });

  const products = Array.from(groups.values()).map((product) => ({
    ...product,
    options: product.options.length ? product.options : [emptyOption()],
  }));

  const optionCount = products.reduce((sum, product) => sum + product.options.length, 0);
  return { products, message: `${products.length}개 상품, ${optionCount}개 옵션을 불러왔습니다.` };
}

function parseUploadText(text) {
  const lines = String(text || '').split(/?
/).filter((line) => line.trim());
  if (lines.length < 2) return { products: [], message: '헤더와 데이터 행이 필요합니다.' };

  const delimiter = lines[0].includes('	') ? '	' : ',';
  const headers = splitRow(lines[0], delimiter);
  const rows = lines.slice(1).map((line) => splitRow(line, delimiter));

  return parseUploadRows(headers, rows);
}

function parseUploadWorkbook(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    return { products: [], message: '엑셀 시트를 찾지 못했습니다.' };
  }

  const sheet = workbook.Sheets[firstSheetName];
  const table = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (!table.length || !table[0]?.length) {
    return { products: [], message: '엑셀 첫 번째 시트에서 헤더를 찾지 못했습니다.' };
  }

  const headers = table[0].map((value) => String(value || '').trim());
  const rows = table
    .slice(1)
    .filter((row) => row.some((cell) => String(cell || '').trim()))
    .map((row) => row.map((cell) => String(cell ?? '').trim()));

  return parseUploadRows(headers, rows);
}

function validateOption(option) {
  const errors = [];
  const reviews = [];

  if (!String(option.sku || '').trim()) errors.push('SKU 필수');

  if (!String(option.price || '').trim()) errors.push('가격 필수');
  else if (!numberOk(option.price)) errors.push('가격 숫자 오류');

  if (!String(option.stock || '').trim()) errors.push('재고 필수');
  else if (!numberOk(option.stock)) errors.push('재고 숫자 오류');

  if (!String(option.weight || '').trim()) errors.push('무게 필수');
  else if (!numberOk(option.weight)) errors.push('무게 숫자 오류');

  [['length', '가로'], ['width', '세로'], ['height', '높이']].forEach(([key, label]) => {
    if (String(option[key] || '').trim() && !numberOk(option[key])) errors.push(`${label} 숫자 오류`);
  });

  if (!String(option.optionName || '').trim()) reviews.push('옵션명 확인 필요: 단품은 Default 또는 - 권장');

  if (errors.length) return { status: 'Error', messages: errors };
  if (reviews.length) return { status: 'Review Required', messages: reviews };
  return { status: 'Ready', messages: ['옵션 입력 완료'] };
}

function validateProduct(product) {
  const errors = [];
  const reviews = [];
  const representativeImages = imageList(product.representativeImagesText);
  const optionValidations = product.options.map(validateOption);
  const optionImageCount = product.options.filter((option) => String(option.optionImage || '').trim()).length;

  if (!String(product.productName || '').trim()) errors.push('상품명 필수');
  if (!String(product.brand || '').trim()) reviews.push('브랜드 확인 필요');
  if (!String(product.description || '').trim()) reviews.push('상품설명 확인 필요');
  if (representativeImages.length > 9) errors.push('대표이미지는 최대 9장');
  if (representativeImages.length === 0) reviews.push('대표이미지 1장 이상 권장');
  if (!product.options.length) errors.push('옵션 행 1개 이상 필요');
  if (optionImageCount > 0 && optionImageCount !== product.options.length) errors.push('옵션이미지는 사용할 경우 모든 옵션 행에 필요');

  if (optionValidations.some((item) => item.status === 'Error')) errors.push('옵션 오류 확인 필요');
  else if (optionValidations.some((item) => item.status === 'Review Required')) reviews.push('옵션 검수 필요');

  if (errors.length) return { status: 'Error', messages: errors, representativeImages, optionValidations };
  if (reviews.length) return { status: 'Review Required', messages: reviews, representativeImages, optionValidations };
  return { status: 'Ready', messages: ['생성 준비 완료'], representativeImages, optionValidations };
}

function StatusBadge({ status }) {
  const styles = {
    Ready: { color: '#15803d', background: '#dcfce7' },
    'Review Required': { color: '#b45309', background: '#fef3c7' },
    Error: { color: '#b91c1c', background: '#fee2e2' },
  };
  const style = styles[status] || styles['Review Required'];
  return (
    <span style={{ borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: style.color, background: style.background }}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function SummaryCard({ title, value, tone }) {
  const colors = {
    blue: ['#eff6ff', '#bfdbfe'],
    green: ['#f0fdf4', '#bbf7d0'],
    yellow: ['#fffbeb', '#fde68a'],
    red: ['#fef2f2', '#fecaca'],
    gray: ['#f9fafb', '#e5e7eb'],
  };
  const [background, border] = colors[tone] || colors.gray;
  return (
    <div style={{ border: `1px solid ${border}`, background, borderRadius: 14, padding: 14 }}>
      <div style={{ color: '#6b7280', fontSize: 12 }}>{title}</div>
      <strong style={{ fontSize: 22 }}>{value}</strong>
    </div>
  );
}

function sampleText() {
  return [
    ['브랜드', '상품명', '상품설명', '대표이미지', '옵션명', 'sku', '가격', '재고', '무게', '가로', '세로', '높이', '옵션이미지'].join('\t'),
    ['No Brand', 'Sample Product', 'Sample description', 'https://example.com/main1.jpg;https://example.com/main2.jpg', 'Default', 'SAMPLE-001', '12.50', '10', '0.20', '10', '8', '4', ''].join('\t'),
    ['No Brand', 'Sample Product', 'Sample description', 'https://example.com/main1.jpg', 'Blue', 'SAMPLE-002-BLUE', '15.00', '5', '0.25', '12', '9', '5', ''].join('\t'),
  ].join('\n');
}

export default function MassUploadPage() {
  const [products, setProducts] = useState([emptyProduct()]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [uploadText, setUploadText] = useState('');
  const [message, setMessage] = useState('표준 헤더 엑셀/CSV 내용을 붙여넣거나 CSV/TSV 파일을 업로드하세요.');

  const validations = useMemo(() => products.map(validateProduct), [products]);
  const selectedProduct = products[selectedIndex] || products[0];
  const selectedValidation = validations[selectedIndex] || validations[0] || validateProduct(emptyProduct());

  const summary = useMemo(() => {
    const base = {
      productCount: products.length,
      optionCount: products.reduce((sum, product) => sum + product.options.length, 0),
      Ready: 0,
      'Review Required': 0,
      Error: 0,
    };
    validations.forEach((item) => {
      base[item.status] += 1;
    });
    return base;
  }, [products, validations]);

  const importText = (text) => {
    const result = parseUploadText(text);
    if (!result.products.length) {
      setMessage(result.message);
      return;
    }
    setProducts(result.products);
    setSelectedIndex(0);
    setMessage(result.message);
  };

  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const result = lowerName.endsWith('.xlsx')
          ? parseUploadWorkbook(reader.result)
          : parseUploadText(String(reader.result || ''));

        if (!result.products.length) {
          setMessage(result.message);
          return;
        }

        setProducts(result.products);
        setSelectedIndex(0);
        setMessage(result.message);

        if (!lowerName.endsWith('.xlsx')) {
          setUploadText(String(reader.result || ''));
        }
      } catch (error) {
        setMessage(`파일 읽기 실패: ${error.message}`);
      }
    };

    if (lowerName.endsWith('.xlsx')) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file, 'utf-8');
    }
  };

  const updateProduct = (field, value) => {
    setProducts((prev) => prev.map((product, index) => (index === selectedIndex ? { ...product, [field]: value } : product)));
  };

  const updateOption = (optionIndex, field, value) => {
    setProducts((prev) => prev.map((product, index) => (
      index !== selectedIndex
        ? product
        : { ...product, options: product.options.map((option, idx) => (idx === optionIndex ? { ...option, [field]: value } : option)) }
    )));
  };

  const addOption = () => {
    setProducts((prev) => prev.map((product, index) => (index === selectedIndex ? { ...product, options: [...product.options, emptyOption()] } : product)));
  };

  const removeOption = (optionIndex) => {
    setProducts((prev) => prev.map((product, index) => {
      if (index !== selectedIndex) return product;
      const options = product.options.filter((_, idx) => idx !== optionIndex);
      return { ...product, options: options.length ? options : [emptyOption()] };
    }));
  };

  const addManualProduct = () => {
    setProducts((prev) => [...prev, emptyProduct()]);
    setSelectedIndex(products.length);
  };

  const clearAll = () => {
    setProducts([emptyProduct()]);
    setSelectedIndex(0);
    setUploadText('');
    setMessage('초기화되었습니다.');
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>대량등록</h1>
        <p>표준 헤더 엑셀/CSV를 업로드하면 상품 공통정보와 옵션정보로 자동 분리합니다. 엑셀은 첫 번째 시트의 첫 행을 헤더로 사용합니다.</p>
        <p>단품도 SKU 사용을 위해 옵션 1개로 처리합니다. 상품 등록/수정/삭제 API는 사용하지 않습니다.</p>
      </header>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>1. 상품 엑셀/CSV 업로드</h2>
        <p style={{ color: '#6b7280' }}>
          지원 파일: .xlsx, .csv, .tsv, .txt / 헤더: 브랜드, 상품명, 상품설명, 대표이미지, 옵션명, sku, 가격, 재고, 무게, 가로, 세로, 높이, 옵션이미지
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={handleFileUpload} />
          <button type="button" onClick={() => { const text = sampleText(); setUploadText(text); importText(text); }}>샘플 데이터 넣기</button>
          <button type="button" onClick={() => importText(uploadText)}>붙여넣기 적용</button>
          <button type="button" onClick={addManualProduct}>수동 상품 1개 추가</button>
          <button type="button" onClick={clearAll}>초기화</button>
          <button type="button" disabled>샘플 양식 다운로드 준비중</button>
        </div>
        <textarea
          value={uploadText}
          onChange={(event) => setUploadText(event.target.value)}
          placeholder="엑셀에서 표준 헤더 포함 범위를 복사해 붙여넣으세요."
          style={{ width: '100%', minHeight: 130, border: '1px solid #d1d5db', borderRadius: 10, padding: 10, marginTop: 12, fontFamily: 'monospace' }}
        />
        <div style={{ marginTop: 8, color: '#6b7280' }}>{message}</div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>2. 업로드 결과 요약</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <SummaryCard title="상품 수" value={summary.productCount} tone="blue" />
          <SummaryCard title="옵션 수" value={summary.optionCount} tone="blue" />
          <SummaryCard title="준비 완료" value={summary.Ready} tone="green" />
          <SummaryCard title="검수 필요" value={summary['Review Required']} tone="yellow" />
          <SummaryCard title="오류" value={summary.Error} tone="red" />
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>3. 상품 선택 / 미리보기</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
          {products.map((product, index) => {
            const validation = validations[index];
            return (
              <button
                key={`${product.productName}-${index}`}
                type="button"
                onClick={() => setSelectedIndex(index)}
                style={{ textAlign: 'left', border: selectedIndex === index ? '2px solid #2563eb' : '1px solid #e5e7eb', background: '#fff', borderRadius: 14, padding: 14 }}
              >
                <StatusBadge status={validation.status} />
                <div style={{ fontWeight: 800, marginTop: 8 }}>{product.productName || '상품명 없음'}</div>
                <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
                  옵션 {product.options.length}개 · 대표이미지 {validation.representativeImages.length}/9
                </div>
                <div style={{ color: '#6b7280', fontSize: 12, marginTop: 4 }}>{validation.messages.join(', ')}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>4. 선택 상품 상세 수정</h2>
        <StatusBadge status={selectedValidation.status} />

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', gap: 12, marginTop: 12 }}>
          <label>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>브랜드</div>
            <input value={selectedProduct.brand || ''} onChange={(event) => updateProduct('brand', event.target.value)} style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 10, padding: 10 }} />
          </label>
          <label>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>상품명</div>
            <input value={selectedProduct.productName || ''} onChange={(event) => updateProduct('productName', event.target.value)} style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 10, padding: 10 }} />
          </label>
        </div>

        <label style={{ display: 'block', marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>상품설명</div>
          <textarea value={selectedProduct.description || ''} onChange={(event) => updateProduct('description', event.target.value)} style={{ width: '100%', minHeight: 90, border: '1px solid #d1d5db', borderRadius: 10, padding: 10 }} />
        </label>

        <label style={{ display: 'block', marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong>대표이미지 URL 목록</strong>
            <span>{selectedValidation.representativeImages.length}/9</span>
          </div>
          <textarea value={selectedProduct.representativeImagesText || ''} onChange={(event) => updateProduct('representativeImagesText', event.target.value)} placeholder="한 줄에 대표이미지 URL 1개" style={{ width: '100%', minHeight: 100, border: '1px solid #d1d5db', borderRadius: 10, padding: 10, fontFamily: 'monospace' }} />
        </label>

        <h3 style={{ marginTop: 18 }}>옵션 테이블</h3>
        <button type="button" onClick={addOption}>옵션 행 추가</button>

        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', minWidth: 1250, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>상태</th>
                {OPTION_FIELDS.map(([key, label]) => (
                  <th key={key} style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>{label}</th>
                ))}
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>관리</th>
              </tr>
            </thead>
            <tbody>
              {selectedProduct.options.map((option, optionIndex) => {
                const validation = selectedValidation.optionValidations[optionIndex] || validateOption(option);
                return (
                  <tr key={`option-${optionIndex}`}>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                      <StatusBadge status={validation.status} />
                      <div style={{ fontSize: 12, marginTop: 6, color: '#6b7280', width: 160 }}>{validation.messages.join(', ')}</div>
                    </td>
                    {OPTION_FIELDS.map(([key, , width]) => (
                      <td key={key} style={{ padding: 6, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                        <input value={option[key] || ''} onChange={(event) => updateOption(optionIndex, key, event.target.value)} style={{ width, border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 9px' }} />
                      </td>
                    ))}
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                      <button type="button" onClick={() => removeOption(optionIndex)}>행 삭제</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>5. 다음 단계 준비중</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled>카테고리 자동 추천 준비중</button>
          <button type="button" disabled>공식 템플릿 업로드 준비중</button>
          <button type="button" disabled>매핑 확인 준비중</button>
          <button type="button" disabled>엑셀 생성 준비중</button>
        </div>
      </section>
    </div>
  );
}
