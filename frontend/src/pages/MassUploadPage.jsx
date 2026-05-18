import { useMemo, useState } from 'react';

const HEADERS = [
  'sku',
  '브랜드',
  '상품명',
  '상품설명',
  '옵션명',
  '가격',
  '재고',
  '무게',
  '가로',
  '세로',
  '높이',
  '이미지1',
  '이미지2',
  '이미지3',
  '이미지4',
  '이미지5',
  '옵션이미지',
];

const REQUIRED_FIELDS = ['sku', '상품명', '가격', '재고', '무게'];
const NUMBER_FIELDS = ['가격', '재고', '무게', '가로', '세로', '높이'];

function createEmptyRow() {
  return HEADERS.reduce((acc, header) => {
    acc[header] = '';
    return acc;
  }, {});
}

function createSampleRows() {
  return [
    {
      ...createEmptyRow(),
      sku: 'SAMPLE-001',
      브랜드: 'No Brand',
      상품명: 'Sample Product',
      상품설명: 'Sample product description for Shopee mass upload.',
      옵션명: '-',
      가격: '12.50',
      재고: '10',
      무게: '0.2',
      가로: '10',
      세로: '8',
      높이: '4',
      이미지1: 'https://example.com/image1.jpg',
    },
    {
      ...createEmptyRow(),
      sku: 'SAMPLE-002-BLUE',
      브랜드: 'No Brand',
      상품명: 'Sample Option Product',
      상품설명: 'Sample option product description.',
      옵션명: 'Blue',
      가격: '15.00',
      재고: '5',
      무게: '0.25',
      가로: '12',
      세로: '9',
      높이: '5',
      이미지1: 'https://example.com/image1.jpg',
      옵션이미지: 'https://example.com/blue.jpg',
    },
  ];
}

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t');
  return line.split(',').map((value) => value.trim());
}

function parsePastedRows(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  let startIndex = 0;
  const firstCells = splitLine(lines[0]).map((cell) => cell.trim());
  const hasHeader = firstCells.some((cell) => HEADERS.includes(cell));
  if (hasHeader) startIndex = 1;

  return lines.slice(startIndex).map((line) => {
    const cells = splitLine(line);
    const row = createEmptyRow();
    HEADERS.forEach((header, index) => {
      row[header] = cells[index] ? String(cells[index]).trim() : '';
    });
    return row;
  });
}

function validateRow(row) {
  const errors = [];
  const reviews = [];

  REQUIRED_FIELDS.forEach((field) => {
    if (!String(row[field] || '').trim()) {
      errors.push(`${field} 필수`);
    }
  });

  NUMBER_FIELDS.forEach((field) => {
    const value = String(row[field] || '').trim();
    if (value && Number.isNaN(Number(value))) {
      errors.push(`${field} 숫자 오류`);
    }
  });

  const hasImage = ['이미지1', '이미지2', '이미지3', '이미지4', '이미지5'].some((field) =>
    String(row[field] || '').trim()
  );

  if (!hasImage) {
    reviews.push('상품 이미지 확인 필요');
  }

  if (!String(row['상품설명'] || '').trim()) {
    reviews.push('상품설명 검수 필요');
  }

  if (!String(row['브랜드'] || '').trim()) {
    reviews.push('브랜드 검수 필요');
  }

  if (errors.length) {
    return { status: 'Error', messages: errors };
  }

  if (reviews.length) {
    return { status: 'Review Required', messages: reviews };
  }

  return { status: 'Ready', messages: ['생성 가능'] };
}

function StatusBadge({ status }) {
  const color =
    status === 'Ready'
      ? '#15803d'
      : status === 'Error'
      ? '#b91c1c'
      : '#b45309';

  const background =
    status === 'Ready'
      ? '#dcfce7'
      : status === 'Error'
      ? '#fee2e2'
      : '#fef3c7';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 700,
        color,
        background,
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  );
}

export default function MassUploadPage() {
  const [rows, setRows] = useState([createEmptyRow()]);
  const [pasteText, setPasteText] = useState('');

  const validations = useMemo(() => rows.map(validateRow), [rows]);
  const summary = useMemo(() => {
    return validations.reduce(
      (acc, item) => {
        acc.total += 1;
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      },
      { total: 0, Ready: 0, 'Review Required': 0, Error: 0 }
    );
  }, [validations]);

  const updateCell = (rowIndex, field, value) => {
    setRows((prev) =>
      prev.map((row, index) => (index === rowIndex ? { ...row, [field]: value } : row))
    );
  };

  const addRow = () => {
    setRows((prev) => [...prev, createEmptyRow()]);
  };

  const removeRow = (rowIndex) => {
    setRows((prev) => {
      const next = prev.filter((_, index) => index !== rowIndex);
      return next.length ? next : [createEmptyRow()];
    });
  };

  const addSamples = () => {
    setRows(createSampleRows());
  };

  const applyPaste = () => {
    const parsed = parsePastedRows(pasteText);
    if (parsed.length) setRows(parsed);
  };

  const clearRows = () => {
    setRows([createEmptyRow()]);
    setPasteText('');
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>대량등록</h1>
        <p>Shopee 공식 카테고리별 Mass Upload Excel Template을 채우는 도구입니다.</p>
        <p>상품 등록/수정/삭제 API는 사용하지 않습니다.</p>
        <p>현재 1차 화면은 상품 데이터 입력과 검증 중심입니다. 템플릿 업로드, 매핑, 엑셀 생성은 다음 단계에서 연결합니다.</p>
      </header>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>진행 단계</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          {['1. 상품 입력', '2. 공식 템플릿 업로드', '3. 매핑 확인', '4. 검증', '5. 엑셀 생성'].map((label, index) => (
            <div
              key={label}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 12,
                padding: 12,
                background: index === 0 ? '#eff6ff' : '#f9fafb',
                fontWeight: 700,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>요약</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <div><strong>전체</strong><br />{summary.total}</div>
          <div><strong>Ready</strong><br />{summary.Ready || 0}</div>
          <div><strong>Review</strong><br />{summary['Review Required'] || 0}</div>
          <div><strong>Error</strong><br />{summary.Error || 0}</div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>상품 데이터 입력</h2>
        <p style={{ marginTop: 0 }}>
          붙여넣기는 탭 구분 또는 콤마 구분을 지원합니다. 첫 줄에 헤더가 있으면 자동으로 건너뜁니다.
        </p>

        <textarea
          value={pasteText}
          onChange={(event) => setPasteText(event.target.value)}
          placeholder={HEADERS.join('\t')}
          style={{
            width: '100%',
            minHeight: 110,
            border: '1px solid #d1d5db',
            borderRadius: 10,
            padding: 12,
            fontFamily: 'monospace',
          }}
        />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button type="button" onClick={applyPaste}>붙여넣기 적용</button>
          <button type="button" onClick={addRow}>행 추가</button>
          <button type="button" onClick={addSamples}>샘플 넣기</button>
          <button type="button" onClick={clearRows}>초기화</button>
          <button type="button" disabled>공식 템플릿 업로드 준비중</button>
          <button type="button" disabled>매핑 확인 준비중</button>
          <button type="button" disabled>엑셀 생성 준비중</button>
          <button type="button" disabled>Bridge 상태 확인 준비중</button>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>입력 테이블</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1500 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>상태</th>
                {HEADERS.map((header) => (
                  <th key={header} style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>
                    {header}
                  </th>
                ))}
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e5e7eb' }}>관리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const validation = validations[rowIndex];
                return (
                  <tr key={`row-${rowIndex}`}>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                      <StatusBadge status={validation.status} />
                      <div style={{ fontSize: 12, marginTop: 6, color: '#6b7280', minWidth: 160 }}>
                        {validation.messages.join(', ')}
                      </div>
                    </td>

                    {HEADERS.map((header) => (
                      <td key={header} style={{ padding: 6, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                        <input
                          value={row[header] || ''}
                          onChange={(event) => updateCell(rowIndex, header, event.target.value)}
                          style={{
                            width: header === '상품설명' ? 260 : 130,
                            border: '1px solid #d1d5db',
                            borderRadius: 8,
                            padding: '7px 8px',
                          }}
                        />
                      </td>
                    ))}

                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                      <button type="button" onClick={() => removeRow(rowIndex)}>행 삭제</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
