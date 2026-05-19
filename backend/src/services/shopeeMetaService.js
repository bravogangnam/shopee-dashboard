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

async function fetchCategoryRecommendTop1({ tenantId, itemName }) {
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
  const url = buildUrl(path, { item_name: itemName }, 'shop', accessToken, shopId);

  try {
    const resp = await callWithRetry(() => shopeeAxios.get(url), { context: 'ShopeeMeta:category_recommend' });
    const raw = resp?.response || resp || {};
    const categoryIds = Array.isArray(raw.category_id)
      ? raw.category_id
      : Array.isArray(resp?.category_id)
        ? resp.category_id
        : [];

    console.log('[ShopeeMeta] category_recommend parsed', {
      topKeys: Object.keys(resp || {}).slice(0, 20),
      responseKeys: Object.keys((resp && resp.response) || {}).slice(0, 20),
      rawKeys: Object.keys(raw || {}).slice(0, 20),
      category_id_is_array_raw: Array.isArray(raw && raw.category_id),
      category_id_is_array_root: Array.isArray(resp && resp.category_id),
      category_id_count: Array.isArray(categoryIds) ? categoryIds.length : null,
      error: resp && resp.error ? resp.error : null,
      message: resp && resp.message ? resp.message : null,
    });

    const categoryId = categoryIds.length > 0 ? String(categoryIds[0]) : null;
    if (!categoryId) {
      return {
        ok: false,
        error: 'CATEGORY_RECOMMEND_FAILED',
        message: 'category_recommend returned no category_id candidates.',
      };
    }

    return {
      ok: true,
      category: {
        categoryId,
        categoryName: categoryId,
        categoryPath: categoryId,
        source: 'category_recommend',
        confidence: 'auto_top1',
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: 'CATEGORY_RECOMMEND_FAILED',
      message: err?.message || 'category_recommend failed.',
    };
  }
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
      ? await fetchCategoryRecommendTop1({ tenantId, itemName: productName })
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

    results.push({
      productKey: p.productKey,
      productName,
      optionCount,
      category,
      brand: {
        inputBrandName: p.brand || '',
        brandId: null,
        brandName: p.brand || 'No Brand',
        matchStatus: p.brand ? 'review_required' : 'no_brand',
      },
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
