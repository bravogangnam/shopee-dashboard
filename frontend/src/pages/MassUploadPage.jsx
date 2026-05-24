import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

const DISPLAY_HEADERS = ['sku', '브랜드', '상품명', '옵션명', '상품설명', '대표이미지', '무게', '가격', '재고', '가로', '세로', '높이', '옵션이미지'];
const HEADER_ALIASES = { 브랜드:'brand',brand:'brand',상품명:'productName',productname:'productName',product_name:'productName',상품설명:'description',description:'description',대표이미지:'representativeImages',representativeimages:'representativeImages',representative_images:'representativeImages',옵션명:'optionName',optionname:'optionName',option_name:'optionName',sku:'sku',가격:'price',price:'price',재고:'stock',stock:'stock',무게:'weight',weight:'weight',가로:'length',length:'length',세로:'width',width:'width',높이:'height',height:'height',옵션이미지:'optionImage',optionimage:'optionImage',option_image:'optionImage' };
const INTERNAL_TO_DISPLAY = { sku:'sku', brand:'브랜드', productName:'상품명', optionName:'옵션명', description:'상품설명', representativeImages:'대표이미지', weight:'무게', price:'가격', stock:'재고', length:'가로', width:'세로', height:'높이', optionImage:'옵션이미지' };

const TEMPLATE_HEADER_MAPPING = [
  { pattern: /^category$/i, internalField: 'category_id' },
  { pattern: /^product\s*name$/i, internalField: 'productName' },
  { pattern: /^product\s*description$/i, internalField: 'description' },
  { pattern: /^parent\s*sku$/i, internalField: 'parentSku' },
  { pattern: /^variation\s*integration\s*no\.?$/i, internalField: 'variationIntegrationNo' },
  { pattern: /^variation\s*name\s*1$/i, internalField: 'optionGroupName' },
  { pattern: /^option\s*for\s*variation\s*1$/i, internalField: 'optionName' },
  { pattern: /^image\s*per\s*variation$/i, internalField: 'optionImage' },
  { pattern: /^global\s*sku\s*price$/i, internalField: 'price' },
  { pattern: /^stock$/i, internalField: 'stock' },
  { pattern: /^sku$/i, internalField: 'sku' },
  { pattern: /^cover\s*image$/i, internalField: 'representativeImages[0]' },
  { pattern: /^item\s*image\s*[1-8]$/i, internalField: 'representativeImages' },
  { pattern: /^weight$/i, internalField: 'weight' },
  { pattern: /^length$/i, internalField: 'length' },
  { pattern: /^width$/i, internalField: 'width' },
  { pattern: /^height$/i, internalField: 'height' },
  { pattern: /^days\s*to\s*ship$/i, internalField: 'daysToShip' },
  { pattern: /^brand$/i, internalField: 'brandId' },
];

const splitLine = (line) => line.includes('\t') ? line.split('\t').map((v) => v.trim()) : line.split(',').map((v) => v.trim());
const normalizeHeader = (v) => String(v || '').trim().replace(/\s+/g, '').toLowerCase();
const parseRep = (v) => String(v || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
const isNonEmptyRow = (row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== '');
const padProductKey = (n) => `P${String(n).padStart(4, '0')}`;
const gramsToKgForShopee = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const numeric = Number(raw.replace(/,/g, '').replace(/g$/i, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return raw;

  const kg = numeric / 1000;
  return String(Number(kg.toFixed(3)));
};

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
  const [templateRegistry, setTemplateRegistry] = useState({});
  const [templateMessage, setTemplateMessage] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [generatedFiles, setGeneratedFiles] = useState([]);
  const [generateWarnings, setGenerateWarnings] = useState([]);
  const [generateMessage, setGenerateMessage] = useState('');
  const [imageJobId, setImageJobId] = useState('');
  const [imageUploadFiles, setImageUploadFiles] = useState([]);
  const [imageUploadMessage, setImageUploadMessage] = useState('');
  const [uploadedImages, setUploadedImages] = useState([]);
  const [resultAnalysisFile, setResultAnalysisFile] = useState(null);
  const [resultAnalysisMessage, setResultAnalysisMessage] = useState('');
  const [resultAnalysisRows, setResultAnalysisRows] = useState([]);
  const [requiredValuesMessage, setRequiredValuesMessage] = useState('');
  const [requiredValuesRegistry, setRequiredValuesRegistry] = useState({});
  const [requiredValueDrafts, setRequiredValueDrafts] = useState({});
  const [templateFile, setTemplateFile] = useState(null);
  const [templateAnalysis, setTemplateAnalysis] = useState(null);


  const refreshTemplateRegistry = async () => {
    setLoadingTemplates(true);

    try {
      const res = await fetch('/api/shopee-meta/mass-upload/templates', {
        credentials: 'include',
      });
      const data = await res.json();

      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '템플릿 조회 실패');
      }

      const nextRegistry = {};
      (Array.isArray(data.templates) ? data.templates : []).forEach((template) => {
        const key = String(template?.categoryId || '').trim();
        if (key) nextRegistry[key] = template;
      });

      setTemplateRegistry(nextRegistry);
    } catch (err) {
      setTemplateMessage(`서버 템플릿 조회 실패: ${err?.message || '알 수 없는 오류'}`);
    } finally {
      setLoadingTemplates(false);
    }
  };

  useEffect(() => {
    refreshTemplateRegistry();
  }, []);

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


  const categoryRegistryRows = useMemo(() => {
    const map = new Map();

    (metaResults || []).forEach((p) => {
      const categoryId = String(p.category?.categoryId || '').trim() || '미확정';
      if (!map.has(categoryId)) {
        map.set(categoryId, {
          categoryId,
          categoryPath: p.category?.categoryPath || p.category?.categoryName || categoryId,
          productCount: 0,
          brandProcessedCount: 0,
          products: [],
        });
      }

      const row = map.get(categoryId);
      if (!row.categoryPath || row.categoryPath === row.categoryId) {
        row.categoryPath = p.category?.categoryPath || p.category?.categoryName || row.categoryPath;
      }
      row.productCount += 1;
      row.products.push(p);

      if (p.brand?.brandId !== null && p.brand?.brandId !== undefined && p.brand?.brandId !== '') {
        row.brandProcessedCount += 1;
      }
    });

    return Array.from(map.values()).map((row) => {
      const reg = templateRegistry[row.categoryId] || null;
      return {
        ...row,
        templateStatus: reg?.fileName ? '서버 등록됨' : '공식 템플릿 등록 필요',
        templateFileName: reg?.fileName || '-',
        analysisStatus: reg?.analysis ? '분석 완료' : '-',
        headerRow: reg?.analysis?.headerRow || '-',
        dataStartRow: reg?.analysis?.dataStartRow || '-',
        requiredCount: reg?.analysis?.requiredColumns?.length || 0,
        mappingCount: reg?.analysis?.mappingCandidates?.length || 0,
        excelReady: reg?.analysis ? '준비중' : '불가',
      };
    });
  }, [metaResults, templateRegistry]);


  const categoryPreviewRows = useMemo(() => {
    const byProductKey = new Map((metaResults || []).map((m) => [String(m.productKey || ''), m]));
    const grouped = new Map();
    let seq = 1;

    products.forEach((p) => {
      const result = byProductKey.get(String(p.id || ''));
      const categoryId = String(result?.category?.categoryId || '').trim() || '미확정';
      const categoryPath = result?.category?.categoryPath || result?.category?.categoryName || categoryId;
      const brandId = result?.brand?.brandId ?? '';
      const integrationNo = padProductKey(seq++);
      const repImages = Array.isArray(p.representativeImages) ? p.representativeImages : [];
      const coverImage = repImages[0] || '';

      if (!grouped.has(categoryId)) {
        const template = templateRegistry[categoryId] || null;
        grouped.set(categoryId, {
          categoryId,
          categoryPath,
          templateStatus: template?.fileName ? '서버 등록됨' : '등록 필요',
          templateAnalysis: template?.analysis || null,
          rows: [],
        });
      }

      const bucket = grouped.get(categoryId);

      (p.options || []).forEach((o, optionIndex) => {
        const isFirstOption = optionIndex === 0;

        const row = {
          Category: categoryId === '미확정' ? '' : categoryId,
          'Product Name': isFirstOption ? (p.productName || '') : '',
          'Product Description': isFirstOption ? (p.description || '') : '',
          'Variation Integration No.': integrationNo,
          'Variation Name1': 'Option',
          'Option for Variation 1': String(o.optionName || '').trim() || 'Default',
          'Image per Variation': String(o.optionImage || '').trim(),
          'Global SKU Price': String(o.price || '').trim(),
          Stock: String(o.stock || '').trim(),
          SKU: String(o.sku || '').trim(),
          'Cover image': isFirstOption ? coverImage : '',
          'Item Image 1': isFirstOption ? (repImages[0] || '') : '',
          'Item Image 2': isFirstOption ? (repImages[1] || '') : '',
          'Item Image 3': isFirstOption ? (repImages[2] || '') : '',
          'Item Image 4': isFirstOption ? (repImages[3] || '') : '',
          'Item Image 5': isFirstOption ? (repImages[4] || '') : '',
          'Item Image 6': isFirstOption ? (repImages[5] || '') : '',
          'Item Image 7': isFirstOption ? (repImages[6] || '') : '',
          'Item Image 8': isFirstOption ? (repImages[7] || '') : '',
          Weight: gramsToKgForShopee(o.weight),
          Length: String(o.length || '').trim(),
          Width: String(o.width || '').trim(),
          Height: String(o.height || '').trim(),
          'Days to ship': '1',
          Brand: brandId === null || brandId === undefined ? '' : String(brandId).trim(),
          _missing: [],
        };

        const alwaysRequired = ['Category', 'Variation Integration No.', 'Variation Name1', 'Option for Variation 1', 'Global SKU Price', 'Stock', 'SKU', 'Weight', 'Days to ship', 'Brand'];
        const firstRowRequired = ['Product Name', 'Product Description', 'Cover image'];
        const missingKeys = isFirstOption ? [...alwaysRequired, ...firstRowRequired] : alwaysRequired;

        row._missing = missingKeys.filter((key) => !String(row[key] || '').trim());
        bucket.rows.push(row);
      });
    });

    return Array.from(grouped.values()).map((group) => ({
      ...group,
      rowCount: group.rows.length,
      missingCount: group.rows.reduce((sum, row) => sum + row._missing.length, 0),
    }));
  }, [metaResults, products, templateRegistry]);


  const canGenerateTemplateFiles = useMemo(() => {
    if (!products.length || !metaResults.length || !categoryPreviewRows.length) return false;
    return categoryPreviewRows.every((group) =>
      group.categoryId !== '미확정' && Boolean(templateRegistry[group.categoryId]?.fileName)
    );
  }, [products, metaResults, categoryPreviewRows, templateRegistry]);




  const refreshRequiredValues = async () => {
    try {
      const res = await fetch('/api/shopee-meta/mass-upload/required-values', {
        credentials: 'include',
      });
      const data = await res.json();

      if (!data?.ok) {
        throw new Error(data?.message || data?.error || 'Required Values 조회 실패');
      }

      const next = {};
      (Array.isArray(data.values) ? data.values : []).forEach((row) => {
        const key = String(row?.categoryId || '').trim();
        if (key) next[key] = row;
      });

      setRequiredValuesRegistry(next);
    } catch (err) {
      setRequiredValuesMessage(`Required Values 조회 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };

  const getRequiredValueDraft = (categoryId, attributeName) => {
    return requiredValueDrafts?.[categoryId]?.[attributeName] ?? '';
  };

  const setRequiredValueDraft = (categoryId, attributeName, value) => {
    setRequiredValueDrafts((prev) => ({
      ...prev,
      [categoryId]: {
        ...(prev[categoryId] || {}),
        [attributeName]: value,
      },
    }));
  };

  const saveRequiredValuesForCategory = async (row) => {
    const categoryId = String(row?.categoryId || '').trim();
    if (!categoryId || !Array.isArray(row?.attributes) || row.attributes.length === 0) {
      setRequiredValuesMessage('저장할 Required Values가 없습니다.');
      return;
    }

    const items = row.attributes.map((attr) => ({
      attributeName: attr.name,
      value: getRequiredValueDraft(categoryId, attr.name),
      columnIndex: attr.columnIndex || null,
      requirement: attr.requirement || '',
      rule: attr.rule || '',
      code: attr.code || '',
      source: 'manual',
    }));

    const nonEmptyItems = items.filter((item) => String(item.value || '').trim());

    if (!nonEmptyItems.length) {
      setRequiredValuesMessage('값을 하나 이상 입력해야 저장할 수 있습니다.');
      return;
    }

    try {
      setRequiredValuesMessage(`category_id ${categoryId} Required Values 저장 중...`);

      const res = await fetch('/api/shopee-meta/mass-upload/required-values', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          categoryId,
          categoryPath: categoryRegistryRows.find((x) => String(x.categoryId) === categoryId)?.categoryPath || '',
          scope: 'shared',
          items: nonEmptyItems,
        }),
      });

      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '저장 실패');
      }

      await refreshRequiredValues();
      setRequiredValuesMessage(`category_id ${categoryId} shared Required Values 저장 완료`);
    } catch (err) {
      setRequiredValuesMessage(`Required Values 저장 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };

  const analyzeShopeeResultFile = async () => {
    if (!resultAnalysisFile) {
      setResultAnalysisMessage('Shopee 결과 파일을 선택하세요.');
      return;
    }

    setResultAnalysisMessage('Shopee 결과 파일 분석 중...');

    try {
      const buffer = await resultAnalysisFile.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames.includes('Template') ? 'Template' : workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      if (!sheet) {
        throw new Error('Template 시트를 찾지 못했습니다.');
      }

      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const headers = (matrix[2] || []).map((cell) => String(cell || '').trim());

      const failReasonIndex = headers.findIndex((header) => header.toLowerCase() === 'fail reason');
      const categoryIndex = headers.findIndex((header) => header.toLowerCase() === 'category');

      if (failReasonIndex < 0) {
        throw new Error('Fail Reason 컬럼을 찾지 못했습니다.');
      }

      const commonHeaders = new Set([
        'category',
        'product name',
        'product description',
        'parent sku',
        'variation integration no.',
        'variation name1',
        'option for variation 1',
        'image per variation',
        'variation name2',
        'option for variation 2',
        'global sku price',
        'stock',
        'sku',
        'cover image',
        'item image 1',
        'item image 2',
        'item image 3',
        'item image 4',
        'item image 5',
        'item image 6',
        'item image 7',
        'item image 8',
        'size chart template',
        'size chart image',
        'weight',
        'length',
        'width',
        'height',
        'days to ship',
        'brand',
        'fail reason',
      ]);

      const normalizeForMatch = (value) => String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, ' ')
        .replace(/[^a-z0-9 ]+/g, '')
        .replace(/\s+/g, ' ');

      const getHeaderMatchTerms = (header) => {
        const normalized = normalizeForMatch(header);
        const terms = new Set([normalized]);

        if (normalized === 'shelf lifes') terms.add('shelf life');
        if (normalized === 'shelf life') terms.add('shelf lifes');

        return Array.from(terms).filter(Boolean);
      };

      const candidateHeaders = headers
        .filter(Boolean)
        .filter((header) => !commonHeaders.has(header.toLowerCase()))
        .map((header) => ({
          header,
          normalized: normalizeForMatch(header),
          terms: getHeaderMatchTerms(header),
        }))
        .filter((item) => item.normalized.length >= 3)
        .sort((a, b) => b.normalized.length - a.normalized.length);

      const byCategory = new Map();

      for (let rowIndex = 6; rowIndex < matrix.length; rowIndex += 1) {
        const row = matrix[rowIndex] || [];
        const failReason = String(row[failReasonIndex] || '').trim();

        if (!failReason) continue;

        const categoryId = String(categoryIndex >= 0 ? row[categoryIndex] || '' : '').trim() || '미확정';

        if (!byCategory.has(categoryId)) {
          byCategory.set(categoryId, {
            categoryId,
            failedRows: [],
            missingAttributes: new Set(),
            failReasonSamples: [],
          });
        }

        const bucket = byCategory.get(categoryId);
        bucket.failedRows.push(rowIndex + 1);

        if (bucket.failReasonSamples.length < 3) {
          bucket.failReasonSamples.push(failReason);
        }

        const normalizedReason = ` ${normalizeForMatch(failReason)} `;
        const matchedHeaders = [];

        const attributeNameMatches = Array.from(failReason.matchAll(/Attribute\s+["“”']([^"“”']+)["“”']/gi))
          .map((match) => String(match[1] || '').trim())
          .filter(Boolean);

        attributeNameMatches.forEach((name) => {
          const normalizedName = normalizeForMatch(name);

          const matchedCandidate = candidateHeaders.find((candidate) =>
            (candidate.terms || [candidate.normalized]).some((term) =>
              term === normalizedName || term.replace(/s$/, '') === normalizedName.replace(/s$/, '')
            )
          );

          if (matchedCandidate) {
            matchedHeaders.push(matchedCandidate.header);
          }
        });

        candidateHeaders.forEach((candidate) => {
          const isMatched = (candidate.terms || [candidate.normalized]).some((term) =>
            normalizedReason.includes(` ${term} `)
          );

          if (isMatched) {
            matchedHeaders.push(candidate.header);
          }
        });

        // 긴 속성명이 잡힌 경우, 그 안에 포함되는 짧은 속성명은 제외한다.
        // 예: "Medical Functions"가 있으면 "Medical"은 제외.
        const uniqueMatchedHeaders = Array.from(new Set(matchedHeaders));

        const refinedHeaders = uniqueMatchedHeaders.filter((header) => {
          const current = normalizeForMatch(header);

          return !uniqueMatchedHeaders.some((other) => {
            if (other === header) return false;
            const normalizedOther = normalizeForMatch(other);
            return normalizedOther.length > current.length && normalizedOther.includes(current);
          });
        });

        refinedHeaders.forEach((header) => {
          bucket.missingAttributes.add(header);
        });
      }

      const analyzed = Array.from(byCategory.values()).map((bucket) => {
        const template = templateRegistry[bucket.categoryId] || null;
        const templateColumns = Array.isArray(template?.analysis?.columns) ? template.analysis.columns : [];

        const attributes = Array.from(bucket.missingAttributes).map((name) => {
          const col = templateColumns.find((column) =>
            String(column.header || '').trim().toLowerCase() === String(name || '').trim().toLowerCase()
          );

          return {
            name,
            columnIndex: col?.index || null,
            requirement: col?.requirement || '',
            rule: col?.rule || '',
            description: col?.description || '',
            code: col?.code || '',
          };
        });

        return {
          categoryId: bucket.categoryId,
          failedRowCount: bucket.failedRows.length,
          failedRows: bucket.failedRows,
          attributes,
          failReasonSamples: bucket.failReasonSamples,
        };
      });

      setResultAnalysisRows(analyzed);
      setRequiredValueDrafts((prev) => {
        const next = { ...prev };

        analyzed.forEach((row) => {
          const categoryId = String(row.categoryId || '').trim();
          if (!categoryId) return;

          const savedItems = requiredValuesRegistry[categoryId]?.items || [];
          const savedMap = new Map(savedItems.map((item) => [String(item.attributeName || '').trim(), String(item.value || '')]));

          next[categoryId] = {
            ...(next[categoryId] || {}),
          };

          (row.attributes || []).forEach((attr) => {
            if (next[categoryId][attr.name] == null) {
              next[categoryId][attr.name] = savedMap.get(attr.name) || '';
            }
          });
        });

        return next;
      });
      setResultAnalysisMessage(`분석 완료: ${analyzed.length}개 category_id`);
    } catch (err) {
      setResultAnalysisRows([]);
      setResultAnalysisMessage(`분석 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };

  const uploadImages = async () => {
    if (!imageUploadFiles.length) {
      setImageUploadMessage('이미지를 선택하세요.');
      return;
    }

    setImageUploadMessage('이미지 업로드 중...');

    try {
      const files = await Promise.all(imageUploadFiles.map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        const chunkSize = 0x8000;

        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }

        return {
          fileName: file.name,
          fileBase64: btoa(binary),
          contentType: file.type || '',
        };
      }));

      const res = await fetch('/api/shopee-meta/mass-upload/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          jobId: imageJobId || undefined,
          files,
        }),
      });

      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '업로드 실패');
      }

      setImageJobId(data.jobId || '');
      setUploadedImages(Array.isArray(data.images) ? data.images : []);
      setImageUploadMessage(`업로드 완료: ${(data.images || []).length}개`);
    } catch (err) {
      setImageUploadMessage(`업로드 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };

  const generateTemplateFiles = async () => {
    setGenerateMessage('공식 템플릿 xlsx 생성 중...');
    setGeneratedFiles([]);
    setGenerateWarnings([]);

    try {
      const res = await fetch('/api/shopee-meta/mass-upload/generate-template-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ products, metaResults, imageJobId }),
      });

      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '생성 실패');
      }

      setGeneratedFiles(Array.isArray(data.files) ? data.files : []);
      setGenerateWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setGenerateMessage(`생성 완료: ${(data.files || []).length}개 파일`);
    } catch (err) {
      setGenerateMessage(`생성 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };

  const isRequiredTemplateHeader = (value) => {
    const text = String(value || '').trim();
    return Boolean(text) && (text.includes('*') || /required|mandatory|필수/i.test(text));
  };

  const analyzeTemplateWorkbook = async (file) => {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetNames = workbook.SheetNames || [];
    const hasTemplateSheet = sheetNames.includes('Template');
    const sheetName = hasTemplateSheet ? 'Template' : sheetNames?.[0];
    const sheet = workbook.Sheets[sheetName];

    if (!sheetName || !sheet) {
      throw new Error('템플릿 시트를 찾지 못했습니다.');
    }

    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    const pickValue = (rowIdx, colIdx) => String(matrix?.[rowIdx]?.[colIdx] || '').trim();

    const mapHeaderToInternalField = (header) => {
      const normalizedHeader = String(header || '').trim();
      if (!normalizedHeader) return null;

      const explicit = TEMPLATE_HEADER_MAPPING.find((m) => m.pattern.test(normalizedHeader));
      if (explicit) return explicit.internalField;

      const key = normalizeHeader(normalizedHeader);
      return HEADER_ALIASES[key] || null;
    };

    if (hasTemplateSheet) {
      const headerRowIndex = 2;       // row 3
      const requiredRowIndex = 3;     // row 4
      const descriptionRowIndex = 4;  // row 5
      const ruleRowIndex = 5;         // row 6
      const dataStartRow = 7;

      const colCount = Math.max(
        (matrix?.[0] || []).length,
        (matrix?.[headerRowIndex] || []).length,
        (matrix?.[requiredRowIndex] || []).length,
        (matrix?.[descriptionRowIndex] || []).length,
        (matrix?.[ruleRowIndex] || []).length
      );

      const columns = Array.from({ length: colCount }).map((_, idx) => ({
        index: idx + 1,
        code: pickValue(0, idx),
        header: pickValue(headerRowIndex, idx),
        requirement: pickValue(requiredRowIndex, idx),
        description: pickValue(descriptionRowIndex, idx),
        rule: pickValue(ruleRowIndex, idx),
      })).filter((c) => c.code || c.header || c.requirement || c.description || c.rule);

      const requiredColumns = columns
        .filter((c) => {
          const req = String(c.requirement || '').trim().toLowerCase();
          return req === 'mandatory' || req === 'conditional mandatory';
        })
        .map((c) => ({
          index: c.index,
          header: c.header,
          code: c.code,
          requirement: c.requirement,
        }));

      const mappingCandidates = columns
        .map((c) => {
          const internalField = mapHeaderToInternalField(c.header);
          return internalField ? {
            templateColumn: c.index,
            templateHeader: c.header,
            internalField,
            templateCode: c.code,
          } : null;
        })
        .filter(Boolean);

      return {
        sheetName: 'Template',
        sheetNames,
        headerRow: 3,
        requiredRow: 4,
        descriptionRow: 5,
        ruleRow: 6,
        dataStartRow,
        headerCount: columns.filter((c) => c.header).length,
        columns,
        requiredColumns,
        mappingCandidates,
      };
    }

    let bestHeaderRow = 0;
    let bestScore = -1;

    matrix.slice(0, 40).forEach((row, idx) => {
      const cells = Array.isArray(row) ? row.map((c) => String(c || '').trim()) : [];
      const nonEmpty = cells.filter(Boolean).length;
      const keywordScore = cells.filter((c) =>
        /product|sku|stock|price|brand|category|image|weight|variation|option|attribute|name|description|days|ship|상품|브랜드|가격|재고|필수/i.test(c)
      ).length;
      const requiredScore = cells.filter(isRequiredTemplateHeader).length;
      const score = nonEmpty + keywordScore * 2 + requiredScore * 3;

      if (score > bestScore) {
        bestScore = score;
        bestHeaderRow = idx;
      }
    });

    const headers = (matrix[bestHeaderRow] || []).map((c) => String(c || '').trim());
    const requiredColumns = headers
      .map((h, idx) => ({ index: idx + 1, header: h }))
      .filter((x) => isRequiredTemplateHeader(x.header));

    const mappingCandidates = headers
      .map((header, idx) => {
        const key = normalizeHeader(header);
        const internalField = HEADER_ALIASES[key] || null;
        return internalField ? {
          templateColumn: idx + 1,
          templateHeader: header,
          internalField,
          templateCode: '',
        } : null;
      })
      .filter(Boolean);

    const columns = headers.map((header, idx) => ({
      index: idx + 1,
      code: '',
      header: String(header || '').trim(),
      requirement: '',
      description: '',
      rule: '',
    })).filter((c) => c.header);

    return {
      sheetName,
      sheetNames,
      rowCount: matrix.length,
      headerRow: bestHeaderRow + 1,
      requiredRow: null,
      descriptionRow: null,
      ruleRow: null,
      dataStartRow: bestHeaderRow + 2,
      headerCount: headers.filter(Boolean).length,
      columns,
      requiredColumns,
      mappingCandidates,
    };
  };

  const registerTemplateForCategory = async (categoryId, file) => {
    if (!categoryId || categoryId === '미확정') {
      setTemplateMessage('category_id가 확정된 상품만 템플릿을 등록할 수 있습니다.');
      return;
    }

    if (!file) {
      setTemplateMessage('공식 템플릿 파일을 선택하세요.');
      return;
    }

    try {
      setTemplateMessage(`category_id ${categoryId} 공식 템플릿 분석 중...`);
      const analysis = await analyzeTemplateWorkbook(file);
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 0x8000;

      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }

      const fileBase64 = btoa(binary);
      const categoryPath = categoryRegistryRows.find((row) => row.categoryId === categoryId)?.categoryPath || '';

      const res = await fetch('/api/shopee-meta/mass-upload/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          categoryId,
          categoryPath,
          fileName: file.name,
          fileBase64,
          analysis,
        }),
      });

      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '템플릿 저장 실패');
      }

      await refreshTemplateRegistry();
      setTemplateMessage(`category_id ${categoryId} 서버 템플릿 등록 완료: ${data?.template?.fileName || file.name}`);
    } catch (err) {
      setTemplateMessage(`공식 템플릿 등록 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };

  const deleteTemplateForCategory = async (categoryId) => {
    if (!categoryId || categoryId === '미확정') return;

    try {
      const res = await fetch(`/api/shopee-meta/mass-upload/templates/${encodeURIComponent(categoryId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '템플릿 삭제 실패');
      }

      await refreshTemplateRegistry();
      setTemplateMessage(`category_id ${categoryId} 템플릿 삭제 완료`);
    } catch (err) {
      setTemplateMessage(`템플릿 삭제 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };


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
        <h2>이미지 파일 업로드 / SKU 자동 매칭</h2>
        <p>
          대표이미지는 첫 번째 옵션 SKU-m1, SKU-m2 형식으로 올리고,
          옵션이미지는 각 옵션 SKU 파일명으로 올립니다. 이미지는 리사이즈/압축 없이 원본 그대로 서버에 저장됩니다.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="jobId 선택 입력"
            value={imageJobId}
            onChange={(e) => setImageJobId(e.target.value)}
          />
          <input
            type="file"
            accept=".jpg,.jpeg,.png"
            multiple
            onChange={(e) => setImageUploadFiles(Array.from(e.target.files || []))}
          />
          <button type="button" onClick={uploadImages}>이미지 업로드</button>
        </div>
        {imageUploadMessage ? <p style={{ marginTop: 8 }}>{imageUploadMessage}</p> : null}
        {uploadedImages.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            <p>jobId: {imageJobId} / 업로드 파일 수: {uploadedImages.length}</p>
            {uploadedImages.map((image) => {
              const isMain = /-m\d+$/i.test(String(image.stem || ''));
              return (
                <div key={image.fileName}>
                  {image.fileName} | {isMain ? '대표이미지' : '옵션이미지'} | <a href={image.publicUrl} target="_blank" rel="noreferrer">{image.publicUrl}</a>
                </div>
              );
            })}
          </div>
        ) : null}
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
        <h2>5. category_id별 공식 템플릿 레지스트리</h2>
        <p>
          Shopee OpenAPI에는 KRSC Mass Upload 공식 템플릿 다운로드/생성 API가 없습니다.
          공식 템플릿은 Seller Center에서 아래 카테고리 경로를 찾아 다운로드한 뒤, 해당 category_id 행에서 등록/갱신하세요. 새 카테고리 템플릿도 선택 즉시 자동 분석 후 서버에 저장됩니다.
          서버에 저장된 category_id 템플릿은 다음 대량등록부터 자동으로 불러옵니다. 새 템플릿을 다시 올리면 기존 템플릿을 덮어쓰고 재분석합니다.
        </p>

        {categoryRegistryRows.length > 0 ? (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table style={{ width: '100%', minWidth: 1100, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>category_id</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>카테고리 경로</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>상품 수</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>브랜드 처리</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>템플릿 상태</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>파일명</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>분석 상태</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>헤더/시작행</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>필수/매핑 후보</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>엑셀 생성</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>공식 템플릿 등록</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>삭제</th>
                </tr>
              </thead>
              <tbody>
                {categoryRegistryRows.map((row) => (
                  <tr key={row.categoryId}>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.categoryId}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6, minWidth: 280 }}>{row.categoryPath || '-'}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.productCount}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.brandProcessedCount}/{row.productCount}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.templateStatus}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.templateFileName}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.analysisStatus}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.headerRow} / {row.dataStartRow}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.requiredCount} / {row.mappingCount}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>
                      <button type="button" disabled>공식 템플릿 서버 등록 후 생성 가능</button>
                    </td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>
                      {row.categoryId === '미확정' ? (
                        <span>category_id 필요</span>
                      ) : (
                        <label style={{ border: '1px solid #ddd', borderRadius: 8, padding: '4px 8px', cursor: 'pointer', display: 'inline-block' }}>
                          공식 템플릿 등록/갱신
                          <input
                            type="file"
                            accept=".xlsx"
                            style={{ display: 'none' }}
                            onChange={(e) => registerTemplateForCategory(row.categoryId, e.target.files?.[0] || null)}
                          />
                        </label>
                      )}
                    </td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>
                      <button
                        type="button"
                        onClick={() => deleteTemplateForCategory(row.categoryId)}
                        disabled={!templateRegistry[row.categoryId]}
                      >
                        템플릿 삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ marginTop: 8 }}>KRSC 매핑 결과가 생성되면 category_id별 템플릿 상태가 표시됩니다.</p>
        )}

        {loadingTemplates ? <p style={{ marginTop: 8 }}>서버 템플릿 상태 조회 중...</p> : null}
        {templateMessage ? <p style={{ marginTop: 8 }}>{templateMessage}</p> : null}

        <p style={{ marginTop: 8 }}>
          최종 Excel 생성은 category_id별 공식 템플릿 등록/분석 후 진행됩니다.
        </p>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>6. 공식 템플릿 입력 미리보기</h2>
        <p>
          서버에 저장된 공식 템플릿 분석 결과를 기준으로 Template 시트에 입력될 데이터를 미리 보여줍니다.
          같은 상품의 두 번째 옵션 행부터 Product Name / Product Description / Cover image는 비워질 수 있습니다.
        </p>
        <p>카테고리별 추가 필수 속성은 Required Values 단계에서 처리합니다.</p>

        {categoryPreviewRows.length === 0 ? (
          <p style={{ marginTop: 8 }}>미리보기 대상 데이터가 없습니다. 등록용 엑셀 읽기 및 KRSC 매핑 준비를 먼저 진행하세요.</p>
        ) : (
          categoryPreviewRows.map((group) => (
            <div key={`preview_${group.categoryId}`} style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
              <div><strong>category_id:</strong> {group.categoryId}</div>
              <div><strong>카테고리 경로:</strong> {group.categoryPath || '-'}</div>
              <div><strong>템플릿 상태:</strong> {group.templateStatus}</div>
              <div><strong>생성 예정 행 수:</strong> {group.rowCount}</div>
              <div><strong>누락값 수:</strong> {group.missingCount}</div>
              <div style={{ marginTop: 4 }}>
                <strong>매핑 후보 수:</strong> {Array.isArray(group.templateAnalysis?.mappingCandidates) ? group.templateAnalysis.mappingCandidates.length : 0}
              </div>

              <div style={{ overflowX: 'auto', marginTop: 10 }}>
                <table style={{ width: '100%', minWidth: 1300, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Category', 'Product Name', 'Variation Integration No.', 'Variation Name1', 'Option for Variation 1', 'Global SKU Price', 'Stock', 'SKU', 'Weight', 'Length', 'Width', 'Height', 'Days to ship', 'Brand'].map((header) => (
                        <th key={header} style={{ borderBottom: '1px solid #ddd', padding: 6 }}>{header}</th>
                      ))}
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>누락</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row, idx) => (
                      <tr key={`${group.categoryId}_${idx}`}>
                        {['Category', 'Product Name', 'Variation Integration No.', 'Variation Name1', 'Option for Variation 1', 'Global SKU Price', 'Stock', 'SKU', 'Weight', 'Length', 'Width', 'Height', 'Days to ship', 'Brand'].map((header) => (
                          <td key={header} style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row[header] || ''}</td>
                        ))}
                        <td style={{ borderBottom: '1px solid #eee', padding: 6, color: row._missing.length ? '#b42318' : '#1b7f3b' }}>
                          {row._missing.length ? row._missing.join(', ') : '없음'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>7. 공식 템플릿 xlsx 생성</h2>
        <p>서버에 저장된 공식 template.xlsx를 복사해서 Template 시트 7행부터 데이터를 입력합니다.</p>

        <button type="button" onClick={generateTemplateFiles} disabled={!canGenerateTemplateFiles}>
          공식 템플릿 xlsx 생성
        </button>

        {!canGenerateTemplateFiles ? (
          <p style={{ marginTop: 6 }}>생성 조건: 등록용 상품/매핑 결과 존재 + category_id별 서버 템플릿 등록 완료</p>
        ) : null}

        {generateMessage ? <p style={{ marginTop: 6 }}>{generateMessage}</p> : null}

        {generatedFiles.length > 0 ? (
          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <h3>생성 결과</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>category_id</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>카테고리 경로</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>파일명</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>다운로드</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>warning 수</th>
                </tr>
              </thead>
              <tbody>
                {generatedFiles.map((file) => {
                  const warningCount = generateWarnings.filter((warning) => String(warning.categoryId) === String(file.categoryId)).length;
                  return (
                    <tr key={`${file.categoryId}_${file.fileName}`}>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{file.categoryId}</td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{file.categoryPath || '-'}</td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{file.fileName}</td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6 }}><a href={file.downloadUrl}>다운로드</a></td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{warningCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>



      <section className="card" style={{ marginTop: 16 }}>
        <h2>8. Shopee 업로드 결과 오류 분석</h2>
        <p>
          Shopee Seller Center에서 받은 Result 파일을 업로드하면 Fail Reason 컬럼을 분석해서
          category_id별 누락 필수 속성 후보를 자동으로 추출합니다.
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="file"
            accept=".xlsx"
            onChange={(event) => setResultAnalysisFile(event.target.files?.[0] || null)}
          />
          <button type="button" onClick={analyzeShopeeResultFile}>결과 파일 분석</button>
        </div>

        {resultAnalysisMessage ? <p style={{ marginTop: 8 }}>{resultAnalysisMessage}</p> : null}

        {resultAnalysisRows.length > 0 ? (
          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 1000, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>category_id</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>실패 행 수</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>누락 속성 후보</th>
                  <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>Fail Reason 샘플</th>
                </tr>
              </thead>
              <tbody>
                {resultAnalysisRows.map((row) => (
                  <tr key={row.categoryId}>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.categoryId}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.failedRowCount}</td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>
                      {row.attributes.length ? (
                        row.attributes.map((attr) => (
                          <div key={attr.name} style={{ marginBottom: 6 }}>
                            <strong>{attr.name}</strong>
                            {attr.columnIndex ? <span> / col {attr.columnIndex}</span> : null}
                            {attr.requirement ? <span> / {attr.requirement}</span> : null}
                            {attr.rule ? <div style={{ fontSize: 12, color: '#666', maxWidth: 500 }}>{attr.rule}</div> : null}
                          </div>
                        ))
                      ) : (
                        <span>자동 추출된 속성 없음</span>
                      )}
                    </td>
                    <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>
                      {row.failReasonSamples.map((reason, idx) => (
                        <div key={`${row.categoryId}_${idx}`} style={{ marginBottom: 6, whiteSpace: 'pre-wrap', maxWidth: 500 }}>
                          {reason}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>9. Required Values 입력/저장</h2>
        <p>
          8번 오류 분석에서 추출된 category_id별 누락 속성에 공통값을 입력하고 shared Required Values로 저장합니다.
          저장된 값은 다음 단계에서 공식 템플릿 생성 시 자동 입력됩니다.
        </p>

        {requiredValuesMessage ? <p style={{ marginTop: 8 }}>{requiredValuesMessage}</p> : null}

        {resultAnalysisRows.length === 0 ? (
          <p style={{ marginTop: 8 }}>먼저 8번에서 Shopee Result 파일을 분석하세요.</p>
        ) : (
          resultAnalysisRows.map((row) => {
            const saved = requiredValuesRegistry[row.categoryId] || null;
            return (
              <div key={`required_values_${row.categoryId}`} style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
                <div><strong>category_id:</strong> {row.categoryId}</div>
                <div><strong>저장 상태:</strong> {saved?.items?.length ? `shared 저장됨 (${saved.items.length}개)` : '저장된 값 없음'}</div>

                <table style={{ width: '100%', minWidth: 1100, borderCollapse: 'collapse', marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>속성명</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>컬럼</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>Requirement</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>입력값</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>입력 규칙</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(row.attributes || []).map((attr) => (
                      <tr key={`${row.categoryId}_${attr.name}`}>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{attr.name}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{attr.columnIndex || '-'}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{attr.requirement || '-'}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>
                          <input
                            type="text"
                            value={getRequiredValueDraft(row.categoryId, attr.name)}
                            onChange={(event) => setRequiredValueDraft(row.categoryId, attr.name, event.target.value)}
                            placeholder="공통 입력값"
                            style={{ width: '100%', minWidth: 220 }}
                          />
                        </td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6, fontSize: 12, color: '#666', maxWidth: 520 }}>
                          {attr.rule || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <button type="button" style={{ marginTop: 10 }} onClick={() => saveRequiredValuesForCategory(row)}>
                  shared Required Values 저장
                </button>
              </div>
            );
          })
        )}
      </section>

    </div>
  );
}
