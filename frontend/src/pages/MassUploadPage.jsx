import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

const DISPLAY_HEADERS = ['sku', '브랜드', '상품명', '옵션명', '상품설명', '무게', '가격', '재고', '가로', '세로', '높이'];
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
  (product.options || []).forEach((o, idx) => {
    const p = `옵션 ${idx + 1}`;
    if (!String(o.sku || '').trim()) errors.push(`${p}: sku 필수`);
    ['price', 'stock', 'weight'].forEach((f) => { if (!String(o[f] || '').trim()) errors.push(`${p}: ${f} 필수`); });
  });
  return { status: errors.length ? 'error' : (reviews.length ? 'review' : 'ready') };
}

const badge = (s) => s === 'ready' ? { text: '준비 완료', style: { background: '#e8f7ed', color: '#1b7f3b' } } : s === 'review' ? { text: '검수 필요', style: { background: '#fff7e8', color: '#a46300' } } : { text: '오류', style: { background: '#fdecec', color: '#b42318' } };

const categorySourceLabel = (source) => {
  if (source === 'global_catalog_seed') return 'KRSC/CNSC catalog';
  if (source === 'global_catalog_shared') return 'shared catalog';
  if (source === 'global_catalog_tenant') return 'tenant catalog';
  if (source === 'template_registry_fallback') return 'template fallback';
  return source || '-';
};

const formatBytes = (value) => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
};

export default function MassUploadPage() {
  const CATEGORY_OVERRIDE_KEY = 'krsc_category_overrides_v1';
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
  const [serverImageJobs, setServerImageJobs] = useState([]);
  const [serverImageSummary, setServerImageSummary] = useState({ jobCount: 0, fileCount: 0, totalBytes: 0 });
  const [serverImageMessage, setServerImageMessage] = useState('');
  const [serverImageLoading, setServerImageLoading] = useState(false);
  const [resultAnalysisFile, setResultAnalysisFile] = useState(null);
  const [resultAnalysisMessage, setResultAnalysisMessage] = useState('');
  const [resultAnalysisRows, setResultAnalysisRows] = useState([]);
  const [requiredValuesMessage, setRequiredValuesMessage] = useState('');
  const [requiredValuesRegistry, setRequiredValuesRegistry] = useState({});
  const [requiredValueDrafts, setRequiredValueDrafts] = useState({});
  const [requiredValueOptionsRegistry, setRequiredValueOptionsRegistry] = useState({});
  const [categoryOverrides, setCategoryOverrides] = useState({});
  const [categoryOverrideDrafts, setCategoryOverrideDrafts] = useState({});
  const [categorySearchQueryByProduct, setCategorySearchQueryByProduct] = useState({});
  const [categorySearchResultsByProduct, setCategorySearchResultsByProduct] = useState({});
  const [categorySearchLoadingByProduct, setCategorySearchLoadingByProduct] = useState({});
  const [autoCategoryCandidates, setAutoCategoryCandidates] = useState({});
  const [templateFile, setTemplateFile] = useState(null);
  const [templateAnalysis, setTemplateAnalysis] = useState(null);
  const [preflightRows, setPreflightRows] = useState([]);
  const [preflightSummary, setPreflightSummary] = useState(null);


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


  useEffect(() => {
    try {
      const raw = localStorage.getItem(CATEGORY_OVERRIDE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};

      if (parsed && typeof parsed === 'object') {
        setCategoryOverrides(parsed);

        const draftSeed = {};
        Object.entries(parsed).forEach(([productKey, value]) => {
          draftSeed[productKey] = {
            categoryId: String(value?.categoryId || ''),
            categoryPath: String(value?.categoryPath || ''),
          };
        });
        setCategoryOverrideDrafts(draftSeed);
      }
    } catch {
      setCategoryOverrides({});
      setCategoryOverrideDrafts({});
    }
  }, []);

  const effectiveMetaResults = useMemo(() => {
    return (metaResults || []).map((item) => {
      const productKey = String(item?.productKey || '').trim();
      const override = categoryOverrides?.[productKey] || null;

      if (!override?.categoryId) return item;

      return {
        ...item,
        category: {
          ...(item.category || {}),
          categoryId: String(override.categoryId || '').trim(),
          categoryPath: String(override.categoryPath || '').trim()
            || item?.category?.categoryPath
            || item?.category?.categoryName
            || String(override.categoryId || '').trim(),
          source: 'manual_override',
        },
      };
    });
  }, [metaResults, categoryOverrides]);

  useEffect(() => {
    setCategoryOverrideDrafts((prev) => {
      const next = { ...prev };

      (metaResults || []).forEach((item) => {
        const key = String(item?.productKey || '').trim();
        if (!key || next[key]) return;

        next[key] = {
          categoryId: String(item?.category?.categoryId || ''),
          categoryPath: String(item?.category?.categoryPath || item?.category?.categoryName || ''),
        };
      });

      return next;
    });
  }, [metaResults]);


  const uploadedImageSummary = useMemo(() => {
    const images = Array.isArray(uploadedImages) ? uploadedImages : [];
    const representative = [];
    const option = [];
    const unknown = [];

    images.forEach((image) => {
      const stem = String(image?.stem || '').trim();
      if (!stem) {
        unknown.push(image);
        return;
      }

      if (/-m\d*$/i.test(stem)) {
        representative.push(image);
      } else {
        option.push(image);
      }
    });

    return {
      total: images.length,
      representativeCount: representative.length,
      optionCount: option.length,
      unknownCount: unknown.length,
      representative,
      option,
      unknown,
    };
  }, [uploadedImages]);

  const productsWithUploadedImages = useMemo(() => {
    const images = Array.isArray(uploadedImages) ? uploadedImages : [];

    if (!products.length || !images.length) return products;

    const imagesBySku = new Map();

    images.forEach((image) => {
      const stem = String(image?.stem || '').trim();
      const publicUrl = String(image?.publicUrl || '').trim();

      if (!stem || !publicUrl) return;

      const mainMatch = stem.match(/^(.+)-m(\d*)$/i);
      const sku = (mainMatch ? mainMatch[1] : stem).trim().toUpperCase();
      if (!sku) return;

      if (!imagesBySku.has(sku)) {
        imagesBySku.set(sku, { representative: [], option: [] });
      }

      const bucket = imagesBySku.get(sku);

      if (mainMatch) {
        const order = mainMatch[2] === '' ? 0 : Number(mainMatch[2]);
        bucket.representative.push({ ...image, order: Number.isFinite(order) ? order : 999 });
      } else {
        bucket.option.push(image);
      }
    });

    imagesBySku.forEach((bucket) => {
      bucket.representative.sort((a, b) => (a.order - b.order) || String(a.fileName || '').localeCompare(String(b.fileName || '')));
    });

    return products.map((product) => {
      const options = Array.isArray(product.options) ? product.options : [];
      const firstSku = String(options[0]?.sku || '').trim().toUpperCase();
      const repBucket = firstSku ? imagesBySku.get(firstSku) : null;
      const uploadedRepImages = repBucket?.representative?.map((img) => img.publicUrl).filter(Boolean) || [];
      const currentRepImages = Array.isArray(product.representativeImages) ? product.representativeImages.filter(Boolean) : [];
      const representativeImages = uploadedRepImages.length ? uploadedRepImages : currentRepImages;

      return {
        ...product,
        representativeImages,
        options: options.map((option) => {
          const optionSku = String(option.sku || '').trim().toUpperCase();
          const optionBucket = optionSku ? imagesBySku.get(optionSku) : null;
          const uploadedOptionImage = optionBucket?.option?.[0]?.publicUrl || '';

          return {
            ...option,
            optionImage: uploadedOptionImage || option.optionImage || '',
          };
        }),
      };
    });
  }, [products, uploadedImages]);

  const massUploadProgressSummary = useMemo(() => {
    const productCount = productsWithUploadedImages.length;
    const optionCount = productsWithUploadedImages.reduce((sum, product) => sum + (Array.isArray(product.options) ? product.options.length : 0), 0);
    const effectiveRows = Array.isArray(effectiveMetaResults) ? effectiveMetaResults : [];
    const confirmedCategoryCount = effectiveRows.filter((row) => String(row?.category?.categoryId || '').trim()).length;
    const requiredCategoryIds = Array.from(new Set(effectiveRows.map((row) => String(row?.category?.categoryId || '').trim()).filter(Boolean)));
    const registeredTemplateCount = requiredCategoryIds.filter((categoryId) => Boolean(templateRegistry?.[categoryId]?.fileName)).length;
    const requiredValuesSavedCount = requiredCategoryIds.filter((categoryId) => {
      const saved = requiredValuesRegistry?.[categoryId]?.items || [];
      return Array.isArray(saved) && saved.length > 0;
    }).length;
    const imageCount = Array.isArray(uploadedImages) ? uploadedImages.length : 0;
    const preflightStatus = preflightSummary?.summary || '검사 전';
    const preflightErrorCount = Number(preflightSummary?.errorCount || 0);
    const preflightWarnCount = Number(preflightSummary?.warnCount || 0);
    let nextAction = '상품 엑셀을 업로드하거나 붙여넣기 적용하세요.';
    if (productCount === 0) {
      nextAction = '상품 엑셀을 업로드하거나 붙여넣기 적용하세요.';
    } else if (!effectiveRows.length) {
      nextAction = '카테고리 매핑 시작 버튼을 눌러 카테고리를 확인하세요.';
    } else if (requiredCategoryIds.length > registeredTemplateCount) {
      nextAction = 'category_id별 공식 템플릿을 등록하세요.';
    } else if (preflightErrorCount > 0) {
      nextAction = '생성 전 최종 검사 오류를 먼저 수정하세요.';
    } else if (preflightWarnCount > 0) {
      nextAction = '경고를 확인한 뒤 필요하면 공식 템플릿 xlsx를 생성하세요.';
    } else if (preflightStatus === '검사 전') {
      nextAction = '생성 전 최종 검사를 눌러 마지막 상태를 확인하세요.';
    } else {
      nextAction = 'Shopee 업로드용 xlsx 생성이 가능합니다.';
    }
    return { productCount, optionCount, confirmedCategoryCount, requiredCategoryCount: requiredCategoryIds.length, registeredTemplateCount, requiredValuesSavedCount, imageCount, preflightStatus, preflightErrorCount, preflightWarnCount, nextAction };
  }, [products, effectiveMetaResults, templateRegistry, requiredValuesRegistry, uploadedImages, preflightSummary]);
  const displayRows = useMemo(() => {
    const out = [];
    productsWithUploadedImages.forEach((p, pi) => {
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
  }, [productsWithUploadedImages]);

  const summary = useMemo(() => {
    const out = { products: productsWithUploadedImages.length, options: 0, ready: 0, review: 0, error: 0 };
    productsWithUploadedImages.forEach((p) => { const v = validateProduct(p); out.options += p.options.length; out[v.status] += 1; });
    return out;
  }, [productsWithUploadedImages]);


  const categoryRegistryRows = useMemo(() => {
    const map = new Map();

    (effectiveMetaResults || []).forEach((p) => {
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

      row.brandProcessedCount += 1;
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
  }, [effectiveMetaResults, templateRegistry]);


  const categoryPreviewRows = useMemo(() => {
    const byProductKey = new Map((effectiveMetaResults || []).map((m) => [String(m.productKey || ''), m]));
    const grouped = new Map();
    let seq = 1;

    productsWithUploadedImages.forEach((p) => {
      const result = byProductKey.get(String(p.id || ''));
      const categoryId = String(result?.category?.categoryId || '').trim() || '미확정';
      const categoryPath = result?.category?.categoryPath || result?.category?.categoryName || categoryId;
      const rawBrandId = result?.brand?.brandId;
      const brandId = rawBrandId === null || rawBrandId === undefined || String(rawBrandId).trim() === ''
        ? '0'
        : String(rawBrandId).trim();
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
          Brand: brandId,
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
  }, [effectiveMetaResults, productsWithUploadedImages, templateRegistry]);


  const canGenerateTemplateFiles = useMemo(() => {
    if (!productsWithUploadedImages.length || !effectiveMetaResults.length || !categoryPreviewRows.length) return false;
    return categoryPreviewRows.every((group) =>
      group.categoryId !== '미확정' && Boolean(templateRegistry[group.categoryId]?.fileName)
    );
  }, [productsWithUploadedImages, effectiveMetaResults, categoryPreviewRows, templateRegistry]);




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




  const preflightGroupedByProduct = useMemo(() => {
    const groups = new Map();

    (preflightRows || []).forEach((row, idx) => {
      const productName = String(row?.productName || '(상품명 없음)');

      if (!groups.has(productName)) {
        groups.set(productName, {
          productName,
          rows: [],
          categoryRows: [],
          requiredRows: [],
          imageRows: [],
          basicRows: [],
          counts: { error: 0, warn: 0, ok: 0 },
        });
      }

      const group = groups.get(productName);
      const nextRow = { ...row, _idx: idx };
      const item = String(row?.item || '');
      const message = String(row?.message || '');

      group.rows.push(nextRow);

      if (row.status === 'error') group.counts.error += 1;
      else if (row.status === 'warn') group.counts.warn += 1;
      else group.counts.ok += 1;

      if (item === '카테고리') {
        group.categoryRows.push(nextRow);
      } else if (item === 'Required Values') {
        group.requiredRows.push(nextRow);
      } else if (
        item.includes('대표이미지')
        || item.includes('옵션이미지')
        || item.includes('이미지 URL')
        || item.includes('외부 URL')
        || message.includes('옵션이미지가 일부 옵션에만 있습니다')
      ) {
        group.imageRows.push(nextRow);
      } else {
        group.basicRows.push(nextRow);
      }
    });

    return Array.from(groups.values());
  }, [preflightRows]);

  const getOverrideDraft = (productKey) => {
    return categoryOverrideDrafts?.[productKey] || { categoryId: '', categoryPath: '' };
  };

  const setOverrideDraft = (productKey, field, value) => {
    setCategoryOverrideDrafts((prev) => ({
      ...prev,
      [productKey]: {
        ...(prev[productKey] || { categoryId: '', categoryPath: '' }),
        [field]: value,
      },
    }));
  };


  const setCategorySearchQuery = (productKey, value) => {
    setCategorySearchQueryByProduct((prev) => ({
      ...prev,
      [productKey]: value,
    }));
  };

  const searchCategoriesForProduct = async (productKey) => {
    const query = String(categorySearchQueryByProduct?.[productKey] || '').trim();

    if (!query) {
      setCategorySearchResultsByProduct((prev) => ({ ...prev, [productKey]: [] }));
      return;
    }

    setCategorySearchLoadingByProduct((prev) => ({ ...prev, [productKey]: true }));

    try {
      const res = await fetch(`/api/shopee-meta/mass-upload/category-search?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
      });
      const data = await res.json();

      if (!data?.ok) {
        throw new Error(data?.error || 'CATEGORY_SEARCH_FAILED');
      }

      setCategorySearchResultsByProduct((prev) => ({
        ...prev,
        [productKey]: Array.isArray(data.categories) ? data.categories : [],
      }));
    } catch (err) {
      setCategorySearchResultsByProduct((prev) => ({ ...prev, [productKey]: [] }));
      setMessage(`카테고리 검색 실패: ${err?.message || '알 수 없는 오류'}`);
    } finally {
      setCategorySearchLoadingByProduct((prev) => ({ ...prev, [productKey]: false }));
    }
  };

  const applyCategorySelection = (productKey, category) => {
    const categoryId = String(category?.categoryId || '').trim();
    if (!categoryId) return;

    const categoryPath = String(category?.categoryPath || '').trim();

    const next = {
      ...categoryOverrides,
      [productKey]: {
        categoryId,
        categoryPath,
        source: 'manual_selected',
      },
    };

    setCategoryOverrides(next);
    localStorage.setItem(CATEGORY_OVERRIDE_KEY, JSON.stringify(next));

    setCategoryOverrideDrafts((prev) => ({
      ...prev,
      [productKey]: { categoryId, categoryPath },
    }));

    setMessage(`카테고리 선택 적용 완료: ${productKey} -> ${categoryId}`);
  };



  const tokenizeForCategoryRank = (value) => {
    const stopWords = new Set([
      'the', 'and', 'or', 'for', 'with', 'without', 'from', 'into', 'onto',
      'korea', 'korean', 'genuine', 'popular', 'set', 'type', 'pcs', 'pc', 'ea',
      'box', 'boxes', 'pack', 'packs', 'option', 'new', 'clear', 'series',
      'ml', 'gram', 'grams', 'kg', 'cm', 'mm', 'inch', 'inches',
    ]);

    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 3 && !stopWords.has(x));
  };

  const rankCategoryCandidatesForProduct = (product, candidates) => {
    const productText = [
      product?.productName,
      product?.category?.usedItemName,
      product?.brand?.brandName,
      ...(Array.isArray(product?.options) ? product.options.map((opt) => opt?.optionName) : []),
    ].filter(Boolean).join(' ');

    const productTokens = tokenizeForCategoryRank(productText);
    const productTokenSet = new Set(productTokens);

    const scoreCandidate = (candidate, originalIndex) => {
      const categoryPath = String(candidate?.categoryPath || candidate?.categoryName || '');
      const lowerPath = categoryPath.toLowerCase();
      const pathTokens = tokenizeForCategoryRank(categoryPath);
      const leaf = lowerPath.split('>').pop() || lowerPath;
      const leafTokens = tokenizeForCategoryRank(leaf);

      let score = 0;

      pathTokens.forEach((token) => {
        if (productTokenSet.has(token)) score += 8;
      });

      leafTokens.forEach((token) => {
        if (productTokenSet.has(token)) score += 14;
      });

      productTokens.forEach((token) => {
        if (lowerPath.includes(token)) score += 3;
      });

      if (String(candidate?.source || '').includes('category_recommend')) score += 18;
      if (candidate?.source === 'global_catalog_seed') score += 8;
      if (candidate?.source === 'global_catalog_shared') score += 6;
      if (candidate?.source === 'global_catalog_tenant') score += 5;

      score += Math.min(pathTokens.length, 8);
      score -= originalIndex * 0.01;

      return {
        ...candidate,
        _rankScore: score,
      };
    };

    return (candidates || [])
      .map((candidate, index) => scoreCandidate(candidate, index))
      .sort((a, b) => b._rankScore - a._rankScore)
      .slice(0, 10);
  };

  const refreshAutoCategoryCandidates = async (product) => {
    const productKey = String(product?.productKey || '').trim();
    if (!productKey) return;

    const queries = [
      product?.productName,
      product?.category?.usedItemName,
      product?.brand?.brandName,
      String(product?.productName || '').split(' ').slice(0, 3).join(' '),
    ].map((x) => String(x || '').trim()).filter(Boolean);

    const merged = new Map();

    (Array.isArray(product?.categoryCandidates) ? product.categoryCandidates : []).forEach((candidate) => {
      const id = String(candidate?.categoryId || '').trim();
      if (!id) return;

      merged.set(id, {
        categoryId: id,
        categoryPath: candidate?.categoryPath || id,
        source: candidate?.source || 'category_recommend_candidate',
      });
    });

    if (product?.category?.categoryId) {
      const id = String(product.category.categoryId || '').trim();
      if (id && !merged.has(id)) {
        merged.set(id, {
          categoryId: id,
          categoryPath: product.category.categoryPath || product.category.categoryName || id,
          source: 'category_recommend_top1',
        });
      }
    }

    for (const q of queries.slice(0, 3)) {
      try {
        const res = await fetch(`/api/shopee-meta/mass-upload/category-search?q=${encodeURIComponent(q)}`, {
          credentials: 'include',
        });
        const data = await res.json();
        const rows = Array.isArray(data?.categories) ? data.categories : [];

        rows.forEach((row) => {
          const id = String(row?.categoryId || '').trim();
          if (!id || merged.has(id)) return;
          merged.set(id, row);
        });
      } catch {
        // ignore candidate fetch failures
      }
    }

    const rankedCandidates = rankCategoryCandidatesForProduct(product, Array.from(merged.values()));

    setAutoCategoryCandidates((prev) => ({
      ...prev,
      [productKey]: rankedCandidates,
    }));
  };

  useEffect(() => {
    (metaResults || []).forEach((product) => {
      const key = String(product?.productKey || '').trim();
      if (!key || autoCategoryCandidates[key]) return;
      refreshAutoCategoryCandidates(product);
    });
  }, [metaResults]);

  const saveCategoryOverride = (productKey) => {
    const draft = getOverrideDraft(productKey);
    const categoryId = String(draft.categoryId || '').trim();
    const categoryPath = String(draft.categoryPath || '').trim();

    if (!categoryId) {
      setMessage('category_id가 비어 있으면 수동확정으로 저장할 수 없습니다.');
      return;
    }

    const next = {
      ...categoryOverrides,
      [productKey]: {
        categoryId,
        categoryPath,
        source: 'manual_override',
      },
    };

    setCategoryOverrides(next);
    localStorage.setItem(CATEGORY_OVERRIDE_KEY, JSON.stringify(next));
    setMessage(`수동확정 저장 완료: ${productKey} -> ${categoryId}`);
  };

  const resetCategoryOverride = (productKey) => {
    const next = { ...categoryOverrides };
    delete next[productKey];

    setCategoryOverrides(next);
    localStorage.setItem(CATEGORY_OVERRIDE_KEY, JSON.stringify(next));

    const original = (metaResults || []).find((item) =>
      String(item?.productKey || '') === String(productKey || '')
    );

    setCategoryOverrideDrafts((prev) => ({
      ...prev,
      [productKey]: {
        categoryId: String(original?.category?.categoryId || ''),
        categoryPath: String(original?.category?.categoryPath || original?.category?.categoryName || ''),
      },
    }));

    setMessage(`수동확정 초기화 완료: ${productKey}`);
  };

  const fetchRequiredValueOptionsForCategories = async (categoryIds) => {
    const targets = Array.from(new Set((categoryIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
    if (!targets.length) return;

    const entries = await Promise.all(targets.map(async (categoryId) => {
      try {
        const res = await fetch(`/api/shopee-meta/mass-upload/required-value-options?category_id=${encodeURIComponent(categoryId)}`, {
          credentials: 'include',
        });
        const data = await res.json();

        if (!data?.ok) {
          return [categoryId, { options: [], error: data?.error || 'LOAD_FAILED' }];
        }

        return [categoryId, {
          options: Array.isArray(data.options) ? data.options : [],
          scope: data.scope || '',
        }];
      } catch (err) {
        return [categoryId, { options: [], error: err?.message || 'LOAD_FAILED' }];
      }
    }));

    setRequiredValueOptionsRegistry((prev) => {
      const next = { ...prev };
      entries.forEach(([categoryId, payload]) => {
        next[categoryId] = payload;
      });
      return next;
    });
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
      setRequiredValuesMessage(`category_id ${categoryId} 필수값 저장 완료`);
    } catch (err) {
      setRequiredValuesMessage(`Required Values 저장 실패: ${err?.message || '알 수 없는 오류'}`);
    }
  };

  const analyzeShopeeResultFile = async () => {
    if (!resultAnalysisFile) {
      setResultAnalysisMessage('Shopee 결과 파일을 선택하세요.');
      return;
    }

    setResultAnalysisMessage('Shopee 오류 Result 분석 중...');

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
      await fetchRequiredValueOptionsForCategories(analyzed.map((row) => row.categoryId));
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


  const getOptionMetaForAttribute = (categoryId, attr) => {
    const options = requiredValueOptionsRegistry?.[categoryId]?.options || [];
    const found = options.find((option) =>
      String(option.attributeName || '').trim().toLowerCase() === String(attr.name || '').trim().toLowerCase()
    );
    return found || null;
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

  const refreshServerImageJobs = async ({ silent = false } = {}) => {
    setServerImageLoading(true);
    if (!silent) setServerImageMessage('이미지 현황을 불러오는 중...');

    try {
      const res = await fetch('/api/shopee-meta/mass-upload/images', {
        credentials: 'include',
      });
      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '이미지 현황 조회 실패');
      }

      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      setServerImageJobs(jobs);
      setServerImageSummary({
        jobCount: Number(data.jobCount) || jobs.length,
        fileCount: Number(data.fileCount) || 0,
        totalBytes: Number(data.totalBytes) || 0,
      });
      if (!silent) setServerImageMessage(`이미지 현황 갱신 완료: job ${Number(data.jobCount) || jobs.length}개 / 파일 ${Number(data.fileCount) || 0}개`);
    } catch (err) {
      setServerImageMessage(`이미지 현황 조회 실패: ${err?.message || '알 수 없는 오류'}`);
    } finally {
      setServerImageLoading(false);
    }
  };

  const deleteCurrentImageJob = async () => {
    const targetJobId = String(imageJobId || '').trim();
    if (!targetJobId) {
      setServerImageMessage('삭제할 현재 작업 imageJobId가 없습니다.');
      return;
    }

    if (!window.confirm(`현재 작업 이미지 job(${targetJobId})을 서버에서 삭제할까요?`)) return;

    setServerImageLoading(true);
    setServerImageMessage('현재 작업 이미지 삭제 중...');

    try {
      const res = await fetch(`/api/shopee-meta/mass-upload/images/${encodeURIComponent(targetJobId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '현재 작업 이미지 삭제 실패');
      }

      setImageJobId('');
      setUploadedImages([]);
      setImageUploadFiles([]);
      setImageUploadMessage('현재 작업 이미지가 삭제되어 업로드 상태를 초기화했습니다.');
      setServerImageMessage(`삭제 완료: job ${data.deletedJobCount || 1}개 / 파일 ${data.deletedFileCount || 0}개 / ${formatBytes(data.deletedBytes)}`);
      await refreshServerImageJobs({ silent: true });
    } catch (err) {
      setServerImageMessage(`현재 작업 이미지 삭제 실패: ${err?.message || '알 수 없는 오류'}`);
    } finally {
      setServerImageLoading(false);
    }
  };

  const cleanupOldImageJobs = async () => {
    if (!window.confirm('24시간 지난 서버 업로드 이미지 job만 정리할까요?')) return;

    setServerImageLoading(true);
    setServerImageMessage('24시간 지난 이미지 정리 중...');

    try {
      const res = await fetch('/api/shopee-meta/mass-upload/images/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ olderThanHours: 24 }),
      });
      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.message || data?.error || '오래된 이미지 정리 실패');
      }

      setServerImageMessage(`정리 완료: job ${data.deletedJobCount || 0}개 / 파일 ${data.deletedFileCount || 0}개 / ${formatBytes(data.deletedBytes)}`);
      await refreshServerImageJobs({ silent: true });
    } catch (err) {
      setServerImageMessage(`오래된 이미지 정리 실패: ${err?.message || '알 수 없는 오류'}`);
    } finally {
      setServerImageLoading(false);
    }
  };

  const generateTemplateFiles = async () => {
    setGenerateMessage('Shopee 업로드용 xlsx 생성 중...');
    setGeneratedFiles([]);
    setGenerateWarnings([]);

    try {
      const res = await fetch('/api/shopee-meta/mass-upload/generate-template-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ products: productsWithUploadedImages, metaResults: effectiveMetaResults, imageJobId }),
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


  const runPreflightCheck = () => {
    const rows = [];
    const suspiciousUrlPattern = /(edgeone\.app|positive-aquamarine|disgusted-silver)/i;
    const serverImagePrefix = 'https://junandkang.com/api/shopee-meta/mass-upload/images/public/';
    const byProductKey = new Map((effectiveMetaResults || []).map((m) => [String(m.productKey || ''), m]));
    const requiredByCategory = new Map((resultAnalysisRows || []).map((r) => [String(r.categoryId || ''), r]));

    products.forEach((product) => {
      const productKey = String(product.id || '').trim();
      const meta = byProductKey.get(productKey);
      const productName = String(product.productName || '').trim() || '(상품명 없음)';
      const categoryId = String(meta?.category?.categoryId || '').trim();
      const templateReady = Boolean(templateRegistry?.[categoryId]?.fileName);
      const isManual = String(meta?.category?.source || '').includes('manual');
      const hasCandidates = (autoCategoryCandidates?.[String(meta?.productKey || '').trim()] || []).length > 1;

      if (!categoryId) {
        rows.push({ productName, sku: '-', item: '카테고리', status: 'error', message: 'category_id 미확정' });
      } else {
        if (!templateReady) rows.push({ productName, sku: '-', item: '카테고리', status: 'error', message: `템플릿 미등록 (${categoryId})` });
        if (!isManual && hasCandidates) rows.push({ productName, sku: '-', item: '카테고리', status: 'warn', message: '자동추천 유지 중. 후보 확인 권장' });
      }

      if (!String(product.productName || '').trim()) rows.push({ productName, sku: '-', item: 'Product Name', status: 'error', message: '누락' });
      if (!String(product.description || '').trim()) rows.push({ productName, sku: '-', item: 'Product Description', status: 'error', message: '누락' });

      const categoryRequired = requiredByCategory.get(categoryId);
      const requiredAttrs = Array.isArray(categoryRequired?.attributes) ? categoryRequired.attributes : [];
      if (requiredAttrs.length > 0) {
        const saved = requiredValuesRegistry?.[categoryId]?.items || [];
        if (!saved.length) rows.push({ productName, sku: '-', item: 'Required Values', status: 'error', message: `필수값 후보 ${requiredAttrs.length}개 있으나 저장값 없음` });
        else rows.push({ productName, sku: '-', item: 'Required Values', status: 'ok', message: `저장값 ${saved.length}개 / 생성 시 적용 예정` });
      }

      const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const getUploadedImageMatches = (skuValue) => {
        const normalizedSku = String(skuValue || '').trim();
        if (!normalizedSku) return { representativeImages: [], optionImages: [] };

        const lowerSku = normalizedSku.toLowerCase();
        const representativePattern = new RegExp(`^${escapeRegExp(normalizedSku)}-m\\d*$`, 'i');

        const representativeImages = [];
        const optionImages = [];

        uploadedImages.forEach((img) => {
          const stem = String(img.stem || '').trim();
          if (!stem) return;

          if (stem.toLowerCase() === lowerSku) {
            optionImages.push(img);
            return;
          }

          if (representativePattern.test(stem)) {
            representativeImages.push(img);
          }
        });

        return { representativeImages, optionImages };
      };

      const optionRows = Array.isArray(product.options) ? product.options : [];
      const optionImageStatus = optionRows.map((opt) => {
        const skuValue = String(opt.sku || '').trim();
        const matches = getUploadedImageMatches(skuValue);
        return {
          sku: skuValue,
          hasOptionImage: matches.optionImages.length > 0,
        };
      });

      const optionImageMatched = optionImageStatus.filter((row) => row.sku && row.hasOptionImage).map((row) => row.sku);
      const optionImageMissing = optionImageStatus.filter((row) => row.sku && !row.hasOptionImage).map((row) => row.sku);

      if (optionImageMatched.length > 0 && optionImageMissing.length > 0) {
        rows.push({
          productName,
          sku: '-',
          item: '옵션이미지',
          status: 'warn',
          message: `옵션이미지가 일부 옵션에만 있습니다. 전체 옵션에 넣거나 모두 비우세요. 매칭: ${optionImageMatched.join(', ')} / 누락: ${optionImageMissing.join(', ')}`,
        });
      }

      optionRows.forEach((opt, oi) => {
        const sku = String(opt.sku || '').trim() || '-';

        if (!String(opt.sku || '').trim()) rows.push({ productName, sku, item: 'SKU', status: 'error', message: '누락' });
        if (!String(opt.price || '').trim()) rows.push({ productName, sku, item: '가격', status: 'error', message: '누락' });
        if (!String(opt.stock || '').trim()) rows.push({ productName, sku, item: '재고', status: 'error', message: '누락' });
        if (!String(opt.weight || '').trim()) rows.push({ productName, sku, item: '무게', status: 'error', message: '누락' });

        const rep = Array.isArray(product.representativeImages) ? product.representativeImages : [];
        const matches = getUploadedImageMatches(opt.sku);

        if (oi === 0) {
          if (String(rep[0] || '').trim() || matches.representativeImages.length > 0) {
            const repNames = matches.representativeImages.map((img) => img.fileName).filter(Boolean).slice(0, 5);
            if (repNames.length > 0) {
              rows.push({ productName, sku, item: '대표이미지 매칭', status: 'ok', message: repNames.join(', ') });
            }
          } else {
            rows.push({ productName, sku, item: '대표이미지', status: 'warn', message: '첫 옵션행 대표이미지 누락' });
          }
        }

        if (matches.optionImages.length > 0) {
          rows.push({
            productName,
            sku,
            item: '옵션이미지 매칭',
            status: 'ok',
            message: matches.optionImages.map((img) => img.fileName).filter(Boolean).slice(0, 5).join(', '),
          });
        }

        [opt.optionImage, ...(oi === 0 ? rep : [])].forEach((url) => {
          const u = String(url || '').trim();
          if (!u) return;
          if (suspiciousUrlPattern.test(u)) rows.push({ productName, sku, item: '외부 URL', status: 'warn', message: `테스트/외부 URL 감지: ${u}` });
          if (/^https?:\/\//i.test(u) && !u.startsWith(serverImagePrefix)) rows.push({ productName, sku, item: '이미지 URL', status: 'warn', message: `서버 public URL 아님: ${u}` });
        });
      });
    });

    const errorCount = rows.filter((r) => r.status === 'error').length;
    const warnCount = rows.filter((r) => r.status === 'warn').length;
    const okCount = rows.filter((r) => r.status === 'ok').length;
    const summary = errorCount > 0 ? '생성 전 수정 필요' : warnCount > 0 ? '생성 가능하지만 확인 필요' : '생성 가능';

    setPreflightRows(rows);
    setPreflightSummary({ errorCount, warnCount, okCount, summary });
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
    setMessage('카테고리 매핑 시작 중...');
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
      setMessage(`카테고리 매핑 시작 완료: ${resultProducts.length}건`);
    } catch {
      setMessage('카테고리 매핑 시작 실패');
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
    <div className="mass-upload-page page">
      <header className="page-header">
        <h1>대량등록</h1>
        <p>등록용 엑셀을 업로드하면 Shopee 공식 템플릿 생성용 데이터로 검증합니다.</p>
        <p><strong>기준: KRSC 글로벌 프로덕트 대량등록</strong></p>
      </header>

      <details className="card" style={{ marginTop: 16 }} open>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>진행 요약</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 10 }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#fff' }}>
            <div style={{ fontSize: 12, color: '#667085' }}>상품</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{massUploadProgressSummary.productCount}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#fff' }}>
            <div style={{ fontSize: 12, color: '#667085' }}>옵션</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{massUploadProgressSummary.optionCount}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#fff' }}>
            <div style={{ fontSize: 12, color: '#667085' }}>카테고리 확정</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{massUploadProgressSummary.confirmedCategoryCount}/{massUploadProgressSummary.productCount}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#fff' }}>
            <div style={{ fontSize: 12, color: '#667085' }}>템플릿 등록</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{massUploadProgressSummary.registeredTemplateCount}/{massUploadProgressSummary.requiredCategoryCount}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#fff' }}>
            <div style={{ fontSize: 12, color: '#667085' }}>Required Values</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{massUploadProgressSummary.requiredValuesSavedCount}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#fff' }}>
            <div style={{ fontSize: 12, color: '#667085' }}>이미지 업로드</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{massUploadProgressSummary.imageCount}</div>
          </div>
        </div>

        <div style={{ fontSize: 13, color: '#667085' }}>
          생성 전 최종 검사: {massUploadProgressSummary.preflightStatus}
          {massUploadProgressSummary.preflightErrorCount || massUploadProgressSummary.preflightWarnCount
            ? ` / 오류 ${massUploadProgressSummary.preflightErrorCount} / 경고 ${massUploadProgressSummary.preflightWarnCount}`
            : ''}
        </div>
      </details>
      <details className="card" style={{ marginTop: 16 }} open>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>파일 업로드</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>
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
      </details>

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>이미지 파일 업로드 / SKU 자동 매칭</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>

        <div style={{ border: '1px solid #d9e8ff', background: '#f5f9ff', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>이미지 파일명 규칙</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>대표이미지 / 상품 전체 이미지</div>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                대표이미지는 첫 번째 옵션 SKU에 -m을 붙여 올립니다.<br />
                예: <code>GS02354-m.jpg</code><br />
                추가 대표이미지: <code>GS02354-m1.jpg</code>, <code>GS02354-m2.jpg</code>, <code>GS02354-m3.jpg</code><br />
                단품이나 옵션 1개 상품은 대표이미지만 있어도 됩니다.
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>옵션이미지 / 옵션별 이미지</div>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                옵션별 이미지가 필요하면 각 옵션 SKU 파일명으로 올립니다.<br />
                예: <code>GS02354.jpg</code>, <code>GS02355.jpg</code>, <code>GS02356.jpg</code><br />
                옵션이미지를 사용할 거면 모든 옵션에 넣어야 합니다.<br />
                일부 옵션에만 넣을 거라면 옵션이미지는 모두 비우고 대표이미지만 사용하세요.
              </div>
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 13, color: '#475467' }}>
            등록용 엑셀 테이블에서는 이미지 URL을 입력하지 않습니다. 이미지 업로드 후 생성 전 최종 검사에서 매칭 상태를 확인하세요.
          </div>
        </div>
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
          <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#fff' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
              <div><strong>업로드 완료</strong><br />{uploadedImageSummary.total}개</div>
              <div><strong>대표이미지 후보</strong><br />{uploadedImageSummary.representativeCount}개</div>
              <div><strong>옵션이미지 후보</strong><br />{uploadedImageSummary.optionCount}개</div>
              <div><strong>확인 필요</strong><br />{uploadedImageSummary.unknownCount}개</div>
            </div>

            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: '#475467' }}>업로드 상세 보기</summary>
              <div style={{ marginTop: 8 }}>
                <p style={{ margin: 0, fontSize: 12 }}>jobId: {imageJobId}</p>
                {uploadedImages.map((image) => {
                  const isMain = /-m\d*$/i.test(String(image.stem || ''));
                  return (
                    <div key={image.fileName} style={{ fontSize: 12, marginBottom: 4, wordBreak: 'break-all' }}>
                      {image.fileName} | {isMain ? '대표이미지' : '옵션이미지'} | <a href={image.publicUrl} target="_blank" rel="noreferrer">{image.publicUrl}</a>
                    </div>
                  );
                })}
              </div>
            </details>
          </div>
        ) : null}

        <div style={{ marginTop: 14, border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 700 }}>서버 이미지 관리</div>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#475467' }}>
                대량등록용 서버 업로드 이미지는 임시파일입니다. 원본은 노트북에 보관하고, 24시간 지난 이미지 job은 정리 대상입니다.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={refreshServerImageJobs} disabled={serverImageLoading}>이미지 현황 새로고침</button>
              <button type="button" onClick={deleteCurrentImageJob} disabled={serverImageLoading || !imageJobId}>현재 작업 이미지 삭제</button>
              <button type="button" onClick={cleanupOldImageJobs} disabled={serverImageLoading}>24시간 지난 이미지 정리</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 10 }}>
            <div><strong>서버 job</strong><br />{serverImageSummary.jobCount}개</div>
            <div><strong>서버 파일</strong><br />{serverImageSummary.fileCount}개</div>
            <div><strong>총 용량</strong><br />{formatBytes(serverImageSummary.totalBytes)}</div>
            <div><strong>현재 작업</strong><br />{imageJobId || '-'}</div>
          </div>

          {serverImageMessage ? <p style={{ marginTop: 8 }}>{serverImageMessage}</p> : null}

          {serverImageJobs.length > 0 ? (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: '#475467' }}>서버 이미지 job 목록 보기</summary>
              <div style={{ marginTop: 8, overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>jobId</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>업로드 시각</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>파일 수</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>용량</th>
                    </tr>
                  </thead>
                  <tbody>
                    {serverImageJobs.map((job) => (
                      <tr key={job.jobId}>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{job.jobId}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{job.uploadedAt || '-'}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{job.fileCount || 0}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{formatBytes(job.totalBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </div>
      </details>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>요약</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>상품 수 {summary.products}</span><span>옵션 수 {summary.options}</span><span>준비 완료 {summary.ready}</span><span>검수 필요 {summary.review}</span><span>오류 {summary.error}</span>
        </div>
      </section>

      <details className="card" style={{ marginTop: 16 }} open>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>등록용 엑셀 테이블</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>
        <p style={{ marginTop: 6, fontSize: 13, color: '#475467' }}>
          이미지는 이 표에 입력하지 않습니다. 아래 이미지 업로드 영역에 SKU 파일명으로 올리면 자동으로 매칭됩니다.
        </p>
        <table style={{ width: '100%', minWidth: 1300, borderCollapse: 'collapse' }}>
          <thead>
            <tr>{visibleHeaders.map((h) => <th key={h} style={{ borderBottom: '1px solid #ddd', padding: 6 }}>{h}</th>)}<th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>상태</th></tr>
          </thead>
          <tbody>
            {displayRows.map((r, idx) => { const b = badge(r.status); return <tr key={idx}>{visibleHeaders.map((h) => <td key={h} style={{ borderBottom: '1px solid #eee', padding: 6 }}><input value={r[h] || ''} readOnly style={{ minWidth: 100 }} /></td>)}<td style={{ borderBottom: '1px solid #eee', padding: 6 }}><span style={{ padding: '2px 8px', borderRadius: 999, ...b.style }}>{b.text}</span></td></tr>; })}
          </tbody>
        </table>
      </details>

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>4. 카테고리/브랜드 자동 매핑</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={runKrscPrepare}>카테고리 매핑 시작</button>
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
                  {(() => {
                    const productKey = String(p.productKey || '').trim();
                    const override = categoryOverrides?.[productKey] || null;
                    const effective = effectiveMetaResults.find((item) => String(item.productKey || '').trim() === productKey) || p;
                    const draft = getOverrideDraft(productKey);
                    const isManual = Boolean(override?.categoryId);

                    return (
                      <>
                        <div><strong>{p.productName}</strong> | 옵션 {p.optionCount} | 상태 {p.status}</div>
                        <div>자동추천 category_id: {p.category?.categoryId || '-'} / {p.category?.categoryPath || p.category?.categoryName || '-'}</div>
                        <div>
                          적용 category_id: {effective.category?.categoryId || '-'} / {effective.category?.categoryPath || effective.category?.categoryName || '-'}
                          {isManual ? (
                            <span style={{ marginLeft: 6, background: '#e6f4ff', color: '#0958d9', borderRadius: 999, padding: '2px 8px', fontSize: 12 }}>수동확정</span>
                          ) : (
                            <span style={{ marginLeft: 6, background: '#f5f5f5', color: '#555', borderRadius: 999, padding: '2px 8px', fontSize: 12 }}>자동추천</span>
                          )}
                        </div>
                        <div>category source: {effective.category?.source || '-'} / {effective.category?.confidence || '-'}</div>
                        <div>used item name: {p.category?.usedItemName || '-'}</div>
                        <div>brand: {p.brand?.brandName || '-'} / brand_id: {p.brand?.brandId ?? '-'}</div>
                        <div style={{ marginTop: 8, padding: 8, border: '1px solid #e5e5e5', borderRadius: 6 }}>
                          <div style={{ fontWeight: 600, marginBottom: 6 }}>카테고리 추천 후보</div>
                          {((autoCategoryCandidates[productKey] || []).length > 0) ? (
                            <div style={{ display: 'grid', gap: 6 }}>
                              {(autoCategoryCandidates[productKey] || []).map((candidate) => (
                                <div key={`${productKey}_${candidate.categoryId}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, border: '1px solid #eee', borderRadius: 4, padding: 6 }}>
                                  <div style={{ fontSize: 12 }}>
                                    <div><strong>{candidate.categoryId}</strong> / {candidate.categoryPath || '-'}</div>
                                    <div style={{ color: '#666' }}>{categorySourceLabel(candidate.source)}</div>
                                  </div>
                                  <button type="button" onClick={() => applyCategorySelection(productKey, candidate)}>선택</button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: '#666' }}>자동 후보 없음. 직접 검색 또는 고급 직접 입력을 사용하세요.</div>
                          )}
                          <button type="button" style={{ marginTop: 8 }} onClick={() => refreshAutoCategoryCandidates(p)}>후보 새로고침</button>
                        </div>
                        <div style={{ marginTop: 8, padding: 8, border: '1px solid #ddd', borderRadius: 6, background: '#fafafa' }}>
                          <div style={{ fontWeight: 600, marginBottom: 6 }}>카테고리 수정 (검색/선택)</div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <input
                              type="text"
                              value={categorySearchQueryByProduct?.[productKey] || ''}
                              onChange={(event) => setCategorySearchQuery(productKey, event.target.value)}
                              placeholder="예: blood glucose, dental floss, photo paper"
                              style={{ minWidth: 360, flex: 1 }}
                            />
                            <button type="button" onClick={() => searchCategoriesForProduct(productKey)}>검색</button>
                            <button type="button" onClick={() => resetCategoryOverride(productKey)}>초기화</button>
                          </div>

                          {categorySearchLoadingByProduct?.[productKey] ? <div style={{ marginTop: 6, fontSize: 12 }}>검색 중...</div> : null}

                          {(categorySearchResultsByProduct?.[productKey] || []).length > 0 ? (
                            <div style={{ marginTop: 8, maxHeight: 180, overflow: 'auto', border: '1px solid #eee', borderRadius: 6, background: '#fff' }}>
                              {(categorySearchResultsByProduct?.[productKey] || []).map((category) => (
                                <div key={`${productKey}_${category.categoryId}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: 8, borderBottom: '1px solid #f2f2f2' }}>
                                  <div style={{ fontSize: 12 }}>
                                    <div><strong>{category.categoryId}</strong></div>
                                    <div>{category.categoryPath || '-'}</div>
                                    <div style={{ marginTop: 2, color: '#666' }}>{categorySourceLabel(category.source)}</div>
                                  </div>
                                  <button type="button" onClick={() => applyCategorySelection(productKey, category)}>선택</button>
                                </div>
                              ))}
                            </div>
                          ) : null}

                          <details style={{ marginTop: 8 }}>
                            <summary>고급 직접 입력</summary>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                              <input
                                type="text"
                                value={draft.categoryId}
                                onChange={(event) => setOverrideDraft(productKey, 'categoryId', event.target.value)}
                                placeholder="override category_id"
                                style={{ minWidth: 220 }}
                              />
                              <input
                                type="text"
                                value={draft.categoryPath}
                                onChange={(event) => setOverrideDraft(productKey, 'categoryPath', event.target.value)}
                                placeholder="override categoryPath 선택"
                                style={{ minWidth: 420, flex: 1 }}
                              />
                              <button type="button" onClick={() => saveCategoryOverride(productKey)}>직접입력 저장</button>
                            </div>
                          </details>
                        </div>
                      </>
                    );
                  })()}
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
      </details>

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>5. 공식 템플릿 등록</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>
        <p>
          카테고리별 공식 템플릿은 Shopee Seller Center에서 직접 다운로드해야 합니다.
          다운로드한 템플릿을 해당 category_id 행에 등록하면 서버가 자동으로 분석하고 저장합니다.
          한 번 등록한 템플릿은 다음 대량등록부터 자동으로 사용됩니다. 새 파일을 올리면 기존 템플릿을 덮어쓰고 다시 분석합니다.
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
          <p style={{ marginTop: 8 }}>카테고리 매핑이 끝나면 필요한 템플릿 상태가 여기에 표시됩니다.</p>
        )}

        {loadingTemplates ? <p style={{ marginTop: 8 }}>서버 템플릿 상태 조회 중...</p> : null}
        {templateMessage ? <p style={{ marginTop: 8 }}>{templateMessage}</p> : null}

        <p style={{ marginTop: 8 }}>
          필요한 공식 템플릿이 모두 등록되면 최종 xlsx를 만들 수 있습니다.
        </p>
      </details>

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>6. 입력값 미리보기</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>
        <p>
          생성될 xlsx에 들어갈 값을 미리 확인합니다.
          같은 상품의 두 번째 옵션부터는 상품명/설명/대표이미지가 비어 보일 수 있습니다.
        </p>
        <p>추가 필수값은 9번 필수값 입력/저장에서 처리합니다.</p>

        {categoryPreviewRows.length === 0 ? (
          <p style={{ marginTop: 8 }}>아직 미리볼 데이터가 없습니다. 상품 엑셀을 읽고 4번 카테고리 매핑을 먼저 진행하세요.</p>
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
      </details>

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>7. Shopee 업로드용 xlsx 생성</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>
        <p>등록된 공식 템플릿에 준비된 상품 데이터를 넣어 Shopee 업로드용 xlsx를 만듭니다.</p>

        <div style={{ marginBottom: 8 }}>
          <button type="button" onClick={runPreflightCheck}>생성 전 최종 검사</button>
        </div>

        {preflightSummary ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(120px, 1fr))', gap: 8, marginBottom: 8 }}>
              <div style={{ border: '1px solid #f4c7c3', background: '#fef3f2', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: '#b42318' }}>오류</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#b42318' }}>{preflightSummary.errorCount}</div>
              </div>
              <div style={{ border: '1px solid #f7d9a8', background: '#fffaeb', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: '#a46300' }}>경고</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#a46300' }}>{preflightSummary.warnCount}</div>
              </div>
              <div style={{ border: '1px solid #b7e4c7', background: '#ecfdf3', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: '#1b7f3b' }}>통과</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#1b7f3b' }}>{preflightSummary.okCount}</div>
              </div>
            </div>

            <div
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                fontWeight: 700,
                border: `1px solid ${preflightSummary.errorCount > 0 ? '#f4c7c3' : preflightSummary.warnCount > 0 ? '#f7d9a8' : '#b7e4c7'}`,
                background: preflightSummary.errorCount > 0 ? '#fef3f2' : preflightSummary.warnCount > 0 ? '#fffaeb' : '#ecfdf3',
                color: preflightSummary.errorCount > 0 ? '#b42318' : preflightSummary.warnCount > 0 ? '#a46300' : '#1b7f3b',
              }}
            >
              {preflightSummary.summary}
            </div>
          </div>
        ) : null}

        {preflightGroupedByProduct.length > 0 ? (
          <div style={{ marginBottom: 10, display: 'grid', gap: 10 }}>
            {preflightGroupedByProduct.map((group) => {
              const cardStatus = group.counts.error > 0 ? 'error' : group.counts.warn > 0 ? 'warn' : 'ok';
              const cardColor = cardStatus === 'error' ? '#b42318' : cardStatus === 'warn' ? '#a46300' : '#1b7f3b';
              const cardBg = cardStatus === 'error' ? '#fef3f2' : cardStatus === 'warn' ? '#fffaeb' : '#ecfdf3';

              const renderRows = (rows, isImageSection = false) => {
                if (!rows.length) return <div style={{ fontSize: 12, color: '#667085' }}>없음</div>;

                return rows.map((row) => {
                  const message = String(row.message || '');
                  const isPartialOptionImage = isImageSection && message.includes('옵션이미지가 일부 옵션에만 있습니다');

                  if (isPartialOptionImage) {
                    const matched = (message.match(/매칭:\s*([^/]+)/) || [])[1]?.trim() || '-';
                    const missing = (message.match(/누락:\s*(.+)$/) || [])[1]?.trim() || '-';

                    return (
                      <div key={`group_row_${row._idx}`} style={{ border: '1px solid #f7d9a8', background: '#fff8e1', borderRadius: 6, padding: 8, marginBottom: 6 }}>
                        <div style={{ fontWeight: 700, color: '#a46300', marginBottom: 4 }}>옵션이미지 일부만 있음</div>
                        <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                          <div>- 매칭: {matched}</div>
                          <div>- 누락: {missing}</div>
                          <div>- 해결: 모든 옵션에 이미지를 넣거나 옵션이미지를 모두 제거하세요.</div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={`group_row_${row._idx}`} style={{ display: 'grid', gridTemplateColumns: '84px 110px 1fr', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f2f4f7' }}>
                      <span style={{ color: row.status === 'error' ? '#b42318' : row.status === 'warn' ? '#a46300' : '#1b7f3b', fontWeight: 600 }}>{row.status}</span>
                      <span style={{ color: '#344054' }}>{row.item}</span>
                      <span style={{ color: '#475467', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>[SKU: {row.sku}] {row.message}</span>
                    </div>
                  );
                });
              };

              return (
                <details key={`preflight_group_${group.productName}`} style={{ border: `1px solid ${cardColor}33`, borderRadius: 8, background: '#fff' }}>
                  <summary style={{ cursor: 'pointer', listStyle: 'none', padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: cardBg, borderRadius: 8 }}>
                    <div>
                      <strong>{group.productName}</strong>
                      <div style={{ fontSize: 12, color: '#475467', marginTop: 2 }}>오류 {group.counts.error} / 경고 {group.counts.warn} / 통과 {group.counts.ok}</div>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: cardColor, border: `1px solid ${cardColor}55`, borderRadius: 999, padding: '2px 8px', background: '#fff' }}>
                      {cardStatus === 'error' ? '수정 필요' : cardStatus === 'warn' ? '확인 필요' : '정상'}
                    </span>
                  </summary>

                  <div style={{ padding: 12 }}>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>A. 카테고리 / 템플릿</div>
                      {renderRows(group.categoryRows)}
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>B. 필수값</div>
                      {renderRows(group.requiredRows)}
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>C. 이미지</div>
                      {renderRows(group.imageRows, true)}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>D. 기본 상품값</div>
                      {renderRows(group.basicRows)}
                    </div>
                  </div>
                </details>
              );
            })}

            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: '#475467' }}>전체 상세 테이블 보기</summary>
              <div style={{ marginTop: 8, overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>상품명</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>SKU</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>항목</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>상태</th>
                      <th style={{ borderBottom: '1px solid #ddd', padding: 6 }}>메시지</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preflightRows.map((row, idx) => (
                      <tr key={`preflight_${idx}`}>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.productName}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.sku}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6 }}>{row.item}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6, color: row.status === 'error' ? '#b42318' : row.status === 'warn' ? '#a46300' : '#1b7f3b' }}>{row.status}</td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        ) : null}


        <button type="button" onClick={generateTemplateFiles} disabled={!canGenerateTemplateFiles}>
          Shopee 업로드용 xlsx 생성
        </button>

        {!canGenerateTemplateFiles ? (
          <p style={{ marginTop: 6 }}>생성 조건: 상품 데이터, 카테고리 매핑, 공식 템플릿 등록이 모두 필요합니다.</p>
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
      </details>



      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>8. Shopee 업로드 오류 분석</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>
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
          <button type="button" onClick={analyzeShopeeResultFile}>오류 Result 분석</button>
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
      </details>

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>9. 필수값 입력/저장</h2>
          <span style={{ fontSize: 13, color: '#667085' }}>보기</span>
        </summary>
        <p>
          8번 오류 분석에서 추출된 category_id별 누락 속성에 공통값을 입력하고 shared Required Values로 저장합니다.
          저장된 값은 다음 단계에서 공식 템플릿 생성 시 자동 입력됩니다.
        </p>

        {requiredValuesMessage ? <p style={{ marginTop: 8 }}>{requiredValuesMessage}</p> : null}

        {resultAnalysisRows.length === 0 ? (
          <p style={{ marginTop: 8 }}>먼저 8번에서 Shopee Result 파일을 분석하세요. 누락값이 나오면 여기에서 저장합니다.</p>
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
                          {(() => {
                            const optionMeta = getOptionMetaForAttribute(row.categoryId, attr) || {};
                            const inputKind = optionMeta.inputKind || 'text';
                            const values = Array.isArray(optionMeta.values) ? optionMeta.values : [];
                            const draftValue = getRequiredValueDraft(row.categoryId, attr.name);
                            const listId = `rv_${row.categoryId}_${String(attr.name || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

                            if (inputKind === 'select' && values.length > 0) {
                              return (
                                <>
                                  <select
                                    value={draftValue}
                                    onChange={(event) => setRequiredValueDraft(row.categoryId, attr.name, event.target.value)}
                                    style={{ width: '100%', minWidth: 220 }}
                                  >
                                    <option value="">선택하세요</option>
                                    {values.map((value) => <option key={value} value={value}>{value}</option>)}
                                  </select>
                                  <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>kind: {inputKind} / 후보 {values.length}개</div>
                                </>
                              );
                            }

                            if (inputKind === 'suggest_or_text' && values.length > 0) {
                              return (
                                <>
                                  <input
                                    type="text"
                                    list={listId}
                                    value={draftValue}
                                    onChange={(event) => setRequiredValueDraft(row.categoryId, attr.name, event.target.value)}
                                    placeholder="추천값 선택 또는 직접 입력"
                                    style={{ width: '100%', minWidth: 220 }}
                                  />
                                  <datalist id={listId}>
                                    {values.map((value) => <option key={value} value={value} />)}
                                  </datalist>
                                  <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>kind: {inputKind} / 후보 {values.length}개</div>
                                </>
                              );
                            }

                            return (
                              <>
                                <input
                                  type="text"
                                  value={draftValue}
                                  onChange={(event) => setRequiredValueDraft(row.categoryId, attr.name, event.target.value)}
                                  placeholder={inputKind === 'date' ? 'YYYY/MM/DD' : '공통 입력값'}
                                  style={{ width: '100%', minWidth: 220 }}
                                />
                                <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>kind: {inputKind} / 후보 {values.length}개</div>
                              </>
                            );
                          })()}
                        </td>
                        <td style={{ borderBottom: '1px solid #eee', padding: 6, fontSize: 12, color: '#666', maxWidth: 520 }}>
                          {(() => {
                            const optionMeta = getOptionMetaForAttribute(row.categoryId, attr) || {};
                            const values = Array.isArray(optionMeta.values) ? optionMeta.values : [];

                            return (
                              <>
                                <div>{attr.rule || '-'}</div>
                                {values.length > 0 ? (
                                  <div style={{ marginTop: 4 }}>추천값 미리보기: {values.slice(0, 8).join(', ')}</div>
                                ) : null}
                              </>
                            );
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <button type="button" style={{ marginTop: 10 }} onClick={() => saveRequiredValuesForCategory(row)}>
                  필수값 저장
                </button>
              </div>
            );
          })
        )}
      </details>

    </div>
  );
}
