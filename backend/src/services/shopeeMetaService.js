const META_MODE = 'read_only_bridge';
const LIVE_ENABLED = String(process.env.SHOPEE_META_LIVE_ENABLED || '').toLowerCase() === 'true';

function sanitizeObjectForMetaResponse(input) {
  const secretKeys = new Set(['access_token', 'refresh_token', 'partner_key', 'sign', 'code', 'authorization_code']);
  if (Array.isArray(input)) return input.map(sanitizeObjectForMetaResponse);
  if (!input || typeof input !== 'object') return input;
  const out = {};
  Object.entries(input).forEach(([k, v]) => {
    if (!secretKeys.has(String(k).toLowerCase())) out[k] = sanitizeObjectForMetaResponse(v);
  });
  return out;
}

function norm(v) { return String(v || '').trim(); }
function normalizeMarket(v) { return String(v || '').trim().toUpperCase(); }

function getDb() {
  return require('../config/database');
}

function getShopeeLiveHelpers() {
  const { buildUrl } = require('../utils/shopeeSignature');
  const { callWithRetry, shopeeAxios } = require('../utils/apiWrapper');
  return { buildUrl, callWithRetry, shopeeAxios };
}

async function selectActiveShopForMetadata({ tenantId }) {
  if (!tenantId) return { ok: false, error: 'TENANT_CONTEXT_REQUIRED', message: 'tenant_id context is required.' };
  const db = getDb();
  const [rows] = await db.query(
    `SELECT shop_id, alias, region, token_status
       FROM shops
      WHERE tenant_id = ?
        AND is_active = 1
        AND access_token IS NOT NULL
        AND access_token <> ''
      ORDER BY
        CASE WHEN UPPER(region) = 'SG' THEN 0 ELSE 1 END,
        CASE WHEN token_status = 'active' THEN 0 ELSE 1 END,
        id ASC`,
    [tenantId]
  );

  if (!rows.length) {
    return {
      ok: false,
      error: 'NO_ACTIVE_SHOP_TOKEN',
      message: 'No active shop token is available for this tenant.',
      shop: null,
    };
  }

  const s = rows[0];
  return {
    ok: true,
    shop: {
      shop_id: String(s.shop_id),
      shop_name: s.alias || null,
      region: s.region || null,
      market: normalizeMarket(s.region || ''),
      token_status: s.token_status || null,
    },
  };
}


function tokenizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function buildCategoryPath(category, byId) {
  const parts = [];
  let cursor = category;
  const visited = new Set();

  while (cursor && !visited.has(String(cursor.category_id))) {
    visited.add(String(cursor.category_id));
    const name =
      norm(cursor.display_category_name) ||
      norm(cursor.original_category_name) ||
      norm(cursor.category_name) ||
      String(cursor.category_id);

    if (name) parts.unshift(name);

    const parentId = cursor.parent_category_id;
    if (!parentId || String(parentId) === '0') break;
    cursor = byId.get(String(parentId));
  }

  return parts.join(' > ');
}

function scoreCategoryByKeyword(itemName, categoryName, categoryPath) {
  const tokens = tokenizeText(itemName);
  const haystack = `${String(categoryName || '').toLowerCase()} ${String(categoryPath || '').toLowerCase()}`;
  const weighted = new Set(['blood', 'glucose', 'sugar', 'test', 'strip', 'monitor', 'health', 'medical', 'care']);

  let score = 0;
  tokens.forEach((t) => {
    if (haystack.includes(t)) score += weighted.has(t) ? 3 : 1;
  });

  return score;
}

async function fetchCategoryKeywordFallback({ tenantId, itemName }) {
  if (!LIVE_ENABLED) {
    return {
      ok: false,
      error: 'SHOPEE_META_LIVE_CALL_DISABLED',
      message: 'Live Shopee metadata call disabled.',
    };
  }

  const shopSel = await selectActiveShopForMetadata({ tenantId });
  if (!shopSel.ok) return shopSel;

  const { shop_id: shopId } = shopSel.shop;
  const db = getDb();

  const [tokenRows] = await db.query(
    `SELECT access_token FROM shops WHERE tenant_id = ? AND shop_id = ? LIMIT 1`,
    [tenantId, shopId]
  );

  const accessToken = tokenRows?.[0]?.access_token;
  if (!accessToken) {
    return {
      ok: false,
      error: 'NO_ACTIVE_SHOP_TOKEN',
      message: 'No active shop token is available for this tenant.',
    };
  }

  const { buildUrl, callWithRetry, shopeeAxios } = getShopeeLiveHelpers();
  const path = '/api/v2/product/get_category';
  const url = buildUrl(path, { language: 'en' }, 'shop', accessToken, shopId);

  try {
    const resp = await callWithRetry(() => shopeeAxios.get(url), {
      context: 'ShopeeMeta:get_category_fallback',
    });

    const root = resp?.response || resp || {};
    const categoryList = Array.isArray(root.category_list) ? root.category_list : [];
    const byId = new Map(categoryList.map((c) => [String(c.category_id), c]));

    const leaves = categoryList.filter((c) =>
      c && (c.has_children === false || c.has_children === 0 || c.has_children === 'false')
    );

    let best = null;

    leaves.forEach((c) => {
      const categoryName =
        norm(c.display_category_name) ||
        norm(c.original_category_name) ||
        norm(c.category_name) ||
        String(c.category_id);

      const categoryPath = buildCategoryPath(c, byId);
      const score = scoreCategoryByKeyword(itemName, categoryName, categoryPath);

      if (!best || score > best.score) {
        best = { c, score, categoryName, categoryPath };
      }
    });

    console.log('[ShopeeMeta] get_category fallback', {
      leaf_candidate_count: leaves.length,
      selected_category_id: best?.c?.category_id ? String(best.c.category_id) : null,
      selected_score: best?.score ?? null,
    });

    if (!best || !best.c?.category_id || best.score <= 0) {
      return {
        ok: false,
        error: 'CATEGORY_RECOMMEND_FAILED',
        message: 'get_category keyword fallback found no suitable leaf category.',
      };
    }

    return {
      ok: true,
      category: {
        categoryId: String(best.c.category_id),
        categoryName: best.categoryName,
        categoryPath: best.categoryPath || best.categoryName,
        source: 'category_recommend_failed',
        confidence: 'failed',
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: 'CATEGORY_RECOMMEND_FAILED',
      message: err?.message || 'get_category keyword fallback failed.',
    };
  }
}



function sanitizeCategoryRecommendName(value) {
  return String(value || '')
    .replace(/[|/]+/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeQtyAndBoxTerms(value) {
  return String(value || '')
    .replace(/\b\d+\s*s\b/gi, ' ')
    .replace(/\b\d+\s*pcs?\b/gi, ' ')
    .replace(/\b\d+\s*box\b/gi, ' ')
    .replace(/\bno\s*box\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCategoryRecommendNameCandidates(productName, brandName) {
  const original = norm(productName);
  const brand = norm(brandName);

  const pipeParts = original
    .split('|')
    .map((x) => norm(x))
    .filter(Boolean);

  const withoutBrand = brand
    ? original.replace(new RegExp(escapeRegExp(brand), 'ig'), ' ').replace(/\s+/g, ' ').trim()
    : '';

  const noSymbols = sanitizeCategoryRecommendName(original);
  const noQty = removeQtyAndBoxTerms(noSymbols);
  const noBrandNoQty = brand
    ? removeQtyAndBoxTerms(
        sanitizeCategoryRecommendName(
          original.replace(new RegExp(escapeRegExp(brand), 'ig'), ' ')
        )
      )
    : '';

  const lower = original.toLowerCase();
  const bloodGlucoseCore =
    lower.includes('blood glucose') && lower.includes('test strip')
      ? brand
        ? `${brand} Blood Glucose Test Strips`
        : 'Blood Glucose Test Strips'
      : '';

  return [
    original,
    ...pipeParts,
    noSymbols,
    noQty,
    withoutBrand,
    noBrandNoQty,
    bloodGlucoseCore,
    'Blood Glucose Test Strips',
    'blood sugar test strips',
    'Blood Sugar Test Strips',
  ]
    .map((v) => norm(v))
    .filter(Boolean)
    .map((v) => (v.length > 120 ? v.slice(0, 120).trim() : v))
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

function extractCategoryIdsFromRecommendResponse(resp) {
  const data = resp?.data || resp || {};
  const raw = data?.response || resp?.response || {};
  const fromResponseArray = Array.isArray(raw.category_id) ? raw.category_id : [];
  const fromRootArray = Array.isArray(data?.category_id) ? data.category_id : Array.isArray(resp?.category_id) ? resp.category_id : [];
  const fromCategoryList = Array.isArray(raw.category_list)
    ? raw.category_list.map((x) => x?.category_id).filter(Boolean)
    : [];
  const fromList = Array.isArray(raw.list)
    ? raw.list.map((x) => x?.category_id).filter(Boolean)
    : [];

  return [...fromResponseArray, ...fromRootArray, ...fromCategoryList, ...fromList]
    .map((x) => String(x))
    .filter(Boolean);
}


async function fetchCategoryRecommendTop1({ tenantId, itemName, brandName }) {
  if (!LIVE_ENABLED) {
    return {
      ok: false,
      error: 'SHOPEE_META_LIVE_CALL_DISABLED',
      message: 'Live Shopee metadata call disabled.',
    };
  }

  const shopSel = await selectActiveShopForMetadata({ tenantId });
  if (!shopSel.ok) return shopSel;

  const { shop_id: shopId } = shopSel.shop;
  const db = getDb();

  const [tokenRows] = await db.query(
    `SELECT access_token FROM shops WHERE tenant_id = ? AND shop_id = ? LIMIT 1`,
    [tenantId, shopId]
  );

  const accessToken = tokenRows?.[0]?.access_token;
  if (!accessToken) {
    return {
      ok: false,
      error: 'NO_ACTIVE_SHOP_TOKEN',
      message: 'No active shop token is available for this tenant.',
    };
  }

  const { buildUrl, callWithRetry, shopeeAxios } = getShopeeLiveHelpers();
  const path = '/api/v2/product/category_recommend';
  const candidates = buildCategoryRecommendNameCandidates(itemName, brandName);

  console.log('[ShopeeMeta] category_recommend candidates', {
    productName: itemName,
    candidate_count: candidates.length,
  });

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const url = buildUrl(path, { item_name: candidate }, 'shop', accessToken, shopId);

    try {
      const resp = await callWithRetry(() => shopeeAxios.get(url), {
        context: 'ShopeeMeta:category_recommend',
      });

      const categoryIds = extractCategoryIdsFromRecommendResponse(resp || {});

      console.log('[ShopeeMeta] category_recommend parsed', {
        used_candidate_index: i,
        used_item_name: candidate,
        category_id_count: categoryIds.length,
        error: resp?.data?.error || resp?.error || null,
        message: resp?.data?.message || resp?.message || null,
      });

      const categoryId = categoryIds.length > 0 ? String(categoryIds[0]) : null;
      if (!categoryId) continue;

      return {
        ok: true,
        category: {
          categoryId,
          categoryName: categoryId,
          categoryPath: categoryId,
          source: 'category_recommend',
          confidence: 'auto_top1',
          usedItemName: candidate,
        },
      };
    } catch {
      // try next candidate
    }
  }

  return {
    ok: false,
    error: 'CATEGORY_RECOMMEND_FAILED',
    message: 'Shopee category_recommend가 상품명 기준 카테고리를 반환하지 않았습니다.',
    usedItemName: itemName,
  };
}


async function fetchBrandListForCategory({ tenantId, categoryId }) {
  if (!LIVE_ENABLED || !categoryId) return [];

  const shopSel = await selectActiveShopForMetadata({ tenantId });
  if (!shopSel.ok) return [];

  const { shop_id: shopId } = shopSel.shop;
  const db = getDb();

  const [tokenRows] = await db.query(
    `SELECT access_token FROM shops WHERE tenant_id = ? AND shop_id = ? LIMIT 1`,
    [tenantId, shopId]
  );

  const accessToken = tokenRows?.[0]?.access_token;
  if (!accessToken) return [];

  const { buildUrl, callWithRetry, shopeeAxios } = getShopeeLiveHelpers();
  const path = '/api/v2/product/get_brand_list';

  let offset = 0;
  let page = 0;
  const out = [];

  while (page < 3) {
    const url = buildUrl(
      path,
      {
        category_id: categoryId,
        offset,
        page_size: 100,
        status: 1,
        language: 'en',
      },
      'shop',
      accessToken,
      shopId
    );

    try {
      const resp = await callWithRetry(() => shopeeAxios.get(url), {
        context: 'ShopeeMeta:get_brand_list',
      });

      const root = resp?.data?.response || resp?.response || resp || {};
      const list = Array.isArray(root.brand_list) ? root.brand_list : [];
      out.push(...list);

      if (!root.has_next_page || root.next_offset == null) break;
      offset = root.next_offset;
      page += 1;
    } catch {
      break;
    }
  }

  return out;
}

function matchBrand(inputBrandName, brandList = []) {
  const rawInput = norm(inputBrandName);
  const normalizedInput = normalizeBrandText(rawInput);

  const normalizedRows = brandList.map((b) => ({
    brandId: b?.brand_id != null ? String(b.brand_id) : null,
    displayName: norm(b?.display_brand_name),
    originalName: norm(b?.original_brand_name),
    brandName: norm(b?.brand_name),
  }));

  const noBrandRow = normalizedRows.find((r) =>
    isNoBrandText(r.displayName) ||
    isNoBrandText(r.originalName) ||
    isNoBrandText(r.brandName)
  );

  if (isNoBrandText(rawInput)) {
    return {
      inputBrandName: rawInput,
      brandId: noBrandRow?.brandId || null,
      brandName: noBrandRow?.displayName || noBrandRow?.originalName || noBrandRow?.brandName || 'No brand',
      matchStatus: noBrandRow?.brandId != null ? 'matched' : 'no_brand',
    };
  }

  const exact = normalizedRows.find((r) =>
    normalizeBrandText(r.displayName) === normalizedInput ||
    normalizeBrandText(r.originalName) === normalizedInput ||
    normalizeBrandText(r.brandName) === normalizedInput
  );

  if (exact) {
    return {
      inputBrandName: rawInput,
      brandId: exact.brandId,
      brandName: exact.displayName || exact.originalName || exact.brandName || rawInput,
      matchStatus: 'matched',
    };
  }

  if (noBrandRow?.brandId != null) {
    return {
      inputBrandName: rawInput,
      brandId: noBrandRow.brandId,
      brandName: noBrandRow.displayName || noBrandRow.originalName || noBrandRow.brandName || 'No brand',
      matchStatus: 'no_brand_fallback',
    };
  }

  return {
    inputBrandName: rawInput,
    brandId: null,
    brandName: rawInput || 'No brand',
    matchStatus: rawInput ? 'review_required' : 'no_brand',
  };
}


async function autoMetadataBatchDisabled({ products = [] }) {
  return sanitizeObjectForMetaResponse({
    ok: true,
    mode: 'LEGACY_MARKET_FLOW_DISABLED_FOR_MASS_UPLOAD',
    products: products.map((p) => ({
      productKey: p.productKey,
      productName: p.productName,
      optionCount: p.optionCount || 0,
      daysToShip: 1,
      status: '비활성화',
      message: 'KRSC 메인 흐름에서는 auto-metadata를 사용하지 않습니다. /mass-upload/krsc-prepare를 사용하세요.',
    })),
  });
}

async function krscPrepare({ tenantId, products = [] }) {
  const results = [];

  for (const p of products) {
    const productName = norm(p.productName);
    const optionCount = Number(p.optionCount || 0) || 0;
    const categoryResult = productName
      ? await fetchCategoryRecommendTop1({ tenantId, itemName: productName, brandName: p.brand || '' })
      : {
        ok: false,
        error: 'CATEGORY_RECOMMEND_FAILED',
        message: 'productName is required for category recommendation.',
      };

    const category = categoryResult.ok
      ? categoryResult.category
      : {
        categoryId: null,
        categoryName: '',
        categoryPath: '',
        source: 'category_recommend_failed',
        confidence: 'failed',
      };

    const isCategoryOk = Boolean(category.categoryId);
    const brandList = isCategoryOk
      ? await fetchBrandListForCategory({ tenantId, categoryId: category.categoryId })
      : [];

    const brand = isCategoryOk
      ? matchBrand(p.brand || '', brandList)
      : {
          inputBrandName: p.brand || '',
          brandId: null,
          brandName: p.brand || '',
          matchStatus: 'review_required',
        };

    results.push({
      productKey: p.productKey,
      productName,
      optionCount,
      category,
      brand,
      requiredAttributes: [],
      values: {
        daysToShip: 1,
      },
      itemLimit: {},
      daysToShip: 1,
      status: isCategoryOk ? '카테고리 자동확정' : '추천 실패',
      message: isCategoryOk
        ? '1순위 추천 카테고리로 자동확정되었습니다.'
        : (categoryResult.message || '카테고리 추천에 실패했습니다.'),
    });
  }

  return sanitizeObjectForMetaResponse({
    ok: true,
    mode: 'KRSC_GLOBAL_PRODUCT_MASS_UPLOAD',
    products: results,
  });
}

async function getShopeeMetaStatus() {
  return { ok: true, metadata_api_available: true, mode: META_MODE, endpoints: { mass_upload_krsc_prepare: true } };
}

async function recommendCategory() {
  return { ok: false, error: 'SHOPEE_META_NOT_IMPLEMENTED', message: 'KRSC mass upload flow uses /mass-upload/krsc-prepare.' };
}
async function fetchCategories() { return { ok: false, error: 'SHOPEE_META_NOT_IMPLEMENTED', categories: [] }; }
async function fetchAttributes() { return { ok: false, error: 'SHOPEE_META_NOT_IMPLEMENTED', attributes: [] }; }
async function fetchBrands() { return { ok: false, error: 'SHOPEE_META_NOT_IMPLEMENTED', brands: [] }; }

module.exports = {
  sanitizeObjectForMetaResponse,
  autoMetadataBatchDisabled,
  krscPrepare,
  getShopeeMetaStatus,
  recommendCategory,
  fetchCategories,
  fetchAttributes,
  fetchBrands,
};
