const META_MODE = 'read_only_bridge';

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

async function krscPrepare({ products = [] }) {
  return sanitizeObjectForMetaResponse({
    ok: true,
    mode: 'KRSC_GLOBAL_PRODUCT_MASS_UPLOAD',
    products: products.map((p) => ({
      productKey: p.productKey,
      productName: p.productName,
      optionCount: p.optionCount || 0,
      category: {
        categoryId: null,
        categoryName: '',
        categoryPath: '',
        source: 'manual_required',
        confidence: 'manual_required',
      },
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
      status: '카테고리 확인 필요',
      message: 'KRSC 글로벌 대량등록 기준으로 카테고리와 필수항목 확인이 필요합니다.',
    })),
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
