import { useMemo, useState } from 'react';

const EMPTY_PRODUCT = {
  brand: '',
  productName: '',
  description: '',
  representativeImagesText: '',
};

const OPTION_FIELDS = [
  { key: 'optionName', label: '옵션명', width: 160 },
  { key: 'sku', label: 'SKU', width: 160 },
  { key: 'price', label: '가격', width: 110 },
  { key: 'stock', label: '재고', width: 90 },
  { key: 'weight', label: '무게', width: 100 },
  { key: 'length', label: '가로', width: 90 },
  { key: 'width', label: '세로', width: 90 },
  { key: 'height', label: '높이', width: 90 },
  { key: 'optionImage', label: '옵션이미지 URL', width: 260 },
];

const STATUS_LABELS = {
  Ready: '준비 완료',
  'Review Required': '검수 필요',
  Error: '오류',
};

function createEmptyOption() {
  return {
    optionName: '',
    sku: '',
    price: '',
    stock: '',
    weight: '',
    length: '',
    width: '',
    height: '',
    optionImage: '',
  };
}

function createSampleState() {
  return {
    product: {
      brand: 'No Brand',
      productName: 'Sample Product Name',
      description: 'Sample product description for Shopee mass upload.',
      representativeImagesText: [
        'https://example.com/product-main-1.jpg',
        'https://example.com/product-main-2.jpg',
      ].join('\n'),
    },
    options: [
      {
        optionName: 'Default',
        sku: 'SAMPLE-001',
        price: '12.50',
        stock: '10',
        weight: '0.20',
        length: '10',
        width: '8',
        height: '4',
        optionImage: '',
      },
      {
        optionName: 'Blue',
        sku: 'SAMPLE-002-BLUE',
        price: '15.00',
        stock: '5',
        weight: '0.25',
        length: '12',
        width: '9',
        height: '5',
        optionImage: '',
      },
    ],
  };
}

function parseImageUrls(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t').map((value) => value.trim());
  return line.split(',').map((value) => value.trim());
}

function parsePastedOptions(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const headerKeys = OPTION_FIELDS.map((field) => field.label);
  const firstCells = splitLine(lines[0]);
  const hasHeader = firstCells.some(
    (cell) => headerKeys.includes(cell) || OPTION_FIELDS.some((field) => field.key === cell)
  );
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    const cells = splitLine(line);
    const option = createEmptyOption();
    OPTION_FIELDS.forEach((field, index) => {
      option[field.key] = cells[index] || '';
    });
    return option;
  });
}

function isNumberLike(value) {
  const text = String(value || '').trim();
  return text !== '' && Number.isFinite(Number(text));
}

function validateOption(option) {
  const errors = [];
  const reviews = [];

  if (!String(option.sku || '').trim()) errors.push('SKU 필수');

  if (!String(option.price || '').trim()) errors.push('가격 필수');
  else if (!isNumberLike(option.price)) errors.push('가격 숫자 오류');

  if (!String(option.stock || '').trim()) errors.push('재고 필수');
  else if (!isNumberLike(option.stock)) errors.push('재고 숫자 오류');

  if (!String(option.weight || '').trim()) errors.push('무게 필수');
  else if (!isNumberLike(option.weight)) errors.push('무게 숫자 오류');

  ['length', 'width', 'height'].forEach((field) => {
    if (String(option[field] || '').trim() && !isNumberLike(option[field])) {
      const label = OPTION_FIELDS.find((item) => item.key === field)?.label || field;
      errors.push(`${label} 숫자 오류`);
    }
  });

  if (!String(option.optionName || '').trim()) {
    reviews.push('옵션명 확인 필요: 단품은 Default 또는 - 권장');
  }

  if (errors.length) return { status: 'Error', messages: errors };
  if (reviews.length) return { status: 'Review Required', messages: reviews };
  return { status: 'Ready', messages: ['옵션 입력 완료'] };
}

function validatePage(product, options) {
  const errors = [];
  const reviews = [];
  const representativeImages = parseImageUrls(product.representativeImagesText);
  const optionImageCount = options.filter((option) => String(option.optionImage || '').trim()).length;

  if (!String(product.productName || '').trim()) errors.push('상품명 필수');
  if (!String(product.brand || '').trim()) reviews.push('브랜드 확인 필요');
  if (!String(product.description || '').trim()) reviews.push('상품설명 확인 필요');

  if (representativeImages.length > 9) errors.push('대표이미지는 최대 9장');
  if (representativeImages.length === 0) reviews.push('대표이미지 1장 이상 권장');

  if (!options.length) errors.push('옵션 행 1개 이상 필요');
  if (optionImageCount > 0 && optionImageCount !== options.length) {
    errors.push('옵션이미지는 사용할 경우 모든 옵션 행에 필요');
  }

  if (errors.length) return { status: 'Error', messages: errors, representativeImages, optionImageCount };
  if (reviews.length) return { status: 'Review Required', messages: reviews, representativeImages, optionImageCount };
  return { status: 'Ready', messages: ['상품 공통정보 입력 완료'], representativeImages, optionImageCount };
}

function StatusBadge({ status }) {
  const styleMap = {
    Ready: { color: '#15803d', background: '#dcfce7' },
    'Review Required': { color: '#b45309', background: '#fef3c7' },
    Error: { color: '#b91c1c', background: '#fee2e2' },
  };
  const style = styleMap[status] || styleMap['Review Required'];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 700,
        color: style.color,
        background: style.background,
        whiteSpace: 'nowrap',
      }}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function SummaryCard({ title, value, tone }) {
  const toneMap = {
    green: { background: '#f0fdf4', border: '#bbf7d0' },
    yellow: { background: '#fffbeb', border: '#fde68a' },
    red: { background: '#fef2f2', border: '#fecaca' },
    blue: { background: '#eff6ff', border: '#bfdbfe' },
    gray: { background: '#f9fafb', border: '#e5e7eb' },
  };
  const color = toneMap[tone] || toneMap.gray;

  return (
    <div
      style={{
        border: `1px solid ${color.border}`,
        background: color.background,
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{title}</div>
      <strong style={{ fontSize: 22 }}>{value}</strong>
    </div>
  );
}

export default function MassUploadPage() {
  const [product, setProduct] = useState(EMPTY_PRODUCT);
  const [options, setOptions] = useState([createEmptyOption()]);
  const [pasteText, setPasteText] = useState('');

  const optionValidations = useMemo(() => options.map(validateOption), [options]);
  const pageValidation = useMemo(() => validatePage(product, options), [product, options]);

  const summary = useMemo(() => {
    const base = { total: options.length, Ready: 0, 'Review Required': 0, Error: 0 };
    optionValidations.forEach((item) => {
      base[item.status] += 1;
    });
    if (pageValidation.status === 'Error') base.Error += 1;
    else if (pageValidation.status === 'Review Required') base['Review Required'] += 1;
    return base;
  }, [optionValidations, options.length, pageValidation.status]);

  const updateProduct = (field, value) => {
    setProduct((prev) => ({ ...prev, [field]: value }));
  };

  const updateOption = (rowIndex, field, value) => {
    setOptions((prev) =>
      prev.map((option, index) => (index === rowIndex ? { ...option, [field]: value } : option))
    );
  };

  const addOption = () => setOptions((prev) => [...prev, createEmptyOption()]);

  const removeOption = (rowIndex) => {
    setOptions((prev) => {
      const next = prev.filter((_, index) => index !== rowIndex);
      return next.length ? next : [createEmptyOption()];
    });
  };

  const applyPaste = () => {
    const parsed = parsePastedOptions(pasteText);
    if (parsed.length) setOptions(parsed);
  };

  const loadSamples = () => {
    const sample = createSampleState();
    setProduct(sample.product);
    setOptions(sample.options);
    setPasteText('');
  };

  const clearAll = () => {
    setProduct(EMPTY_PRODUCT);
    setOptions([createEmptyOption()]);
    setPasteText('');
  };

  const optionImageMode =
    pageValidation.optionImageCount === 0
      ? '미사용'
      : pageValidation.optionImageCount === options.length
      ? '전체 입력'
      : '부분 입력 오류';

  return (
    <div className="page">
      <header className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ marginBottom: 0 }}>대량등록</h1>
          <StatusBadge status={pageValidation.status} />
        </div>
        <p>Shopee 공식 Mass Upload Excel Template을 채우기 위한 상품 입력/검증 화면입니다.</p>
        <p>단품도 SKU 사용을 위해 옵션 1개로 입력합니다. 상품 등록/수정/삭제 API는 사용하지 않습니다.</p>
      </header>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>진행 단계</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          {[
            ['1. 상품 입력', '진행중'],
            ['2. 공식 템플릿 업로드', '준비중'],
            ['3. 매핑 확인', '준비중'],
            ['4. 검증', '일부 가능'],
            ['5. 엑셀 생성', '준비중'],
          ].map(([title, state], index) => (
            <div
              key={title}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 14,
                padding: 14,
                background: index === 0 ? '#eff6ff' : '#f9fafb',
              }}
            >
              <strong>{title}</strong>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{state}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>요약</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <SummaryCard title="옵션 수" value={summary.total} tone="blue" />
          <SummaryCard title="준비 완료" value={summary.Ready} tone="green" />
          <SummaryCard title="검수 필요" value={summary['Review Required']} tone="yellow" />
          <SummaryCard title="오류" value={summary.Error} tone="red" />
          <SummaryCard title="대표이미지" value={`${pageValidation.representativeImages.length}/9`} tone="gray" />
          <SummaryCard title="옵션이미지" value={optionImageMode} tone={optionImageMode === '부분 입력 오류' ? 'red' : 'gray'} />
        </div>
        <div style={{ marginTop: 12, color: '#6b7280', fontSize: 13 }}>
          {pageValidation.messages.join(', ')}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>상품 공통정보</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', gap: 12 }}>
          <label>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>브랜드</div>
            <input
              value={product.brand}
              onChange={(event) => updateProduct('brand', event.target.value)}
              placeholder="No Brand"
              style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 10, padding: 10 }}
            />
          </label>
          <label>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>상품명</div>
            <input
              value={product.productName}
              onChange={(event) => updateProduct('productName', event.target.value)}
              placeholder="Shopee에 등록할 상품명"
              style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 10, padding: 10 }}
            />
          </label>
        </div>

        <label style={{ display: 'block', marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>상품설명</div>
          <textarea
            value={product.description}
            onChange={(event) => updateProduct('description', event.target.value)}
            placeholder="상품설명을 입력하세요."
            style={{ width: '100%', minHeight: 90, border: '1px solid #d1d5db', borderRadius: 10, padding: 10 }}
          />
        </label>

        <label style={{ display: 'block', marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
            <strong>대표이미지 URL 목록</strong>
            <span style={{ color: pageValidation.representativeImages.length > 9 ? '#b91c1c' : '#6b7280' }}>
              {pageValidation.representativeImages.length}/9
            </span>
          </div>
          <textarea
            value={product.representativeImagesText}
            onChange={(event) => updateProduct('representativeImagesText', event.target.value)}
            placeholder={'한 줄에 대표이미지 URL 1개\n최대 9장'}
            style={{ width: '100%', minHeight: 110, border: '1px solid #d1d5db', borderRadius: 10, padding: 10, fontFamily: 'monospace' }}
          />
        </label>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>옵션 입력</h2>
        <p style={{ marginTop: 0, color: '#6b7280' }}>
          붙여넣기 컬럼: 옵션명, SKU, 가격, 재고, 무게, 가로, 세로, 높이, 옵션이미지 URL
        </p>
        <textarea
          value={pasteText}
          onChange={(event) => setPasteText(event.target.value)}
          placeholder={'Default\tSKU-001\t12.50\t10\t0.20\t10\t8\t4\t'}
          style={{ width: '100%', minHeight: 90, border: '1px solid #d1d5db', borderRadius: 10, padding: 10, fontFamily: 'monospace' }}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button type="button" onClick={applyPaste}>옵션 붙여넣기 적용</button>
          <button type="button" onClick={addOption}>옵션 행 추가</button>
          <button type="button" onClick={loadSamples}>샘플 넣기</button>
          <button type="button" onClick={clearAll}>초기화</button>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>옵션 테이블</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 1250, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb', position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>상태</th>
                {OPTION_FIELDS.map((field) => (
                  <th key={field.key} style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>
                    {field.label}
                  </th>
                ))}
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>관리</th>
              </tr>
            </thead>
            <tbody>
              {options.map((option, rowIndex) => {
                const validation = optionValidations[rowIndex];
                return (
                  <tr key={`option-${rowIndex}`}>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top', position: 'sticky', left: 0, background: '#fff' }}>
                      <StatusBadge status={validation.status} />
                      <div style={{ fontSize: 12, marginTop: 6, color: '#6b7280', width: 170 }}>
                        {validation.messages.join(', ')}
                      </div>
                    </td>
                    {OPTION_FIELDS.map((field) => (
                      <td key={field.key} style={{ padding: 6, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                        <input
                          value={option[field.key] || ''}
                          onChange={(event) => updateOption(rowIndex, field.key, event.target.value)}
                          style={{
                            width: field.width,
                            border: '1px solid #d1d5db',
                            borderRadius: 8,
                            padding: '8px 9px',
                          }}
                        />
                      </td>
                    ))}
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                      <button type="button" onClick={() => removeOption(rowIndex)}>행 삭제</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>다음 단계 준비중</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled>공식 템플릿 업로드 준비중</button>
          <button type="button" disabled>매핑 확인 준비중</button>
          <button type="button" disabled>엑셀 생성 준비중</button>
          <button type="button" disabled>Bridge 상태 확인 준비중</button>
        </div>
      </section>
    </div>
  );
}
