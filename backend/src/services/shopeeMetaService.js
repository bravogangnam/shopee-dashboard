const META_MODE = 'read_only_bridge';
const LIVE_ENABLED = String(process.env.SHOPEE_META_LIVE_ENABLED || '').toLowerCase() === 'true';


function getDb() {
  return require('../config/database');
}

function getShopeeLiveHelpers() {
  const { buildUrl } = require('../utils/shopeeSignature');
  const { callWithRetry, shopeeAxios } = require('../utils/apiWrapper');
  const { getOrRefreshShopToken } = require('./shopeeAuth');
  return { buildUrl, callWithRetry, shopeeAxios, getOrRefreshShopToken };
}


function createRequestId(prefix = 'meta') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function normalizeMarket(market) { return typeof market === 'string' ? market.trim().toUpperCase() : ''; }
function asArray(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
function cleanText(v) { return typeof v === 'string' ? v.trim() : ''; }

function sanitizeObjectForMetaResponse(input) {
  const secretKeys = new Set(['access_token', 'refresh_token', 'partner_key', 'sign', 'code', 'authorization_code']);
  if (Array.isArray(input)) return input.map(sanitizeObjectForMetaResponse);
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (secretKeys.has(String(k).toLowerCase())) continue;
    out[k] = sanitizeObjectForMetaResponse(v);
  }
  return out;
}

async function selectActiveShopForMetadata({ tenantId, market = '' }) {
  const normalizedMarket = normalizeMarket(market);
  if (!tenantId) return { ok: false, error: 'TENANT_CONTEXT_REQUIRED', message: 'tenant_id context is required.' };
  const db = getDb();
  const [rows] = await db.query(
    `SELECT shop_id, alias, region, token_status
       FROM shops
      WHERE tenant_id = ? AND is_active = 1
        AND access_token IS NOT NULL AND access_token <> ''
      ORDER BY
        CASE WHEN ? <> '' AND UPPER(region) = ? THEN 0 ELSE 1 END,
        CASE WHEN token_status = 'active' THEN 0 ELSE 1 END,
        id ASC`,
    [tenantId, normalizedMarket, normalizedMarket]
  );
  if (!rows.length) return { ok: false, error: 'NO_ACTIVE_SHOP_TOKEN', message: 'No active shop token is available for this tenant.', shop: null };
  const s = rows[0];
  return { ok: true, shop: { shop_id: String(s.shop_id), shop_name: s.alias || null, region: s.region || null, market: s.region || null, token_status: s.token_status || null } };
}

function diagnosticsBase({ apiPath, market, categoryId, requestId }) {
  return sanitizeObjectForMetaResponse({ api_path: apiPath, mode: META_MODE, market: market || null, category_id: categoryId || null, request_id: requestId });
}

function disabledResult({ requestId, apiPath, market, categoryId, shape = {} }) {
  return {
    ok: false,
    error: 'SHOPEE_META_LIVE_CALL_DISABLED',
    message: 'Read-only Shopee metadata bridge is available, but live Shopee API calls are disabled in this environment.',
    ...shape,
    diagnostics: { ...diagnosticsBase({ apiPath, market, categoryId, requestId }), live_enabled: false },
  };
}

async function callShopeeMetaReadOnly({ tenantId, market, path, query = {}, apiType = 'shop' }) {
  const requestId = createRequestId('call');
  const baseDiag = diagnosticsBase({ apiPath: path, market, requestId });
  if (!LIVE_ENABLED) {
    return { ok: false, error: 'SHOPEE_META_LIVE_CALL_DISABLED', message: 'Live Shopee metadata call disabled.', diagnostics: { ...baseDiag, live_enabled: false } };
  }

  const { buildUrl, callWithRetry, shopeeAxios, getOrRefreshShopToken } = getShopeeLiveHelpers();
  const shopSel = await selectActiveShopForMetadata({ tenantId, market });
  if (!shopSel.ok) return { ...shopSel, diagnostics: { ...baseDiag, response_empty: true } };
  const shopId = shopSel.shop.shop_id;
  const accessToken = await getOrRefreshShopToken(shopId, { tenantId });
  if (!accessToken) return { ok: false, error: 'NO_ACTIVE_SHOP_TOKEN', message: 'No active shop token is available for this tenant.', diagnostics: baseDiag };

  const url = buildUrl(path, query, apiType, accessToken, shopId);
  try {
    const data = await callWithRetry(() => shopeeAxios.get(url), { context: `ShopeeMeta:${path}` });
    return { ok: true, data, shop: shopSel.shop, diagnostics: { ...baseDiag, response_keys: Object.keys(data || {}) } };
  } catch (err) {
    return { ok: false, error: 'SHOPEE_META_NOT_IMPLEMENTED', message: err.message || 'Shopee metadata call failed.', diagnostics: { ...baseDiag, response_empty: true } };
  }
}

const callProductApiReadOnly = (opts) => callShopeeMetaReadOnly({ ...opts, apiType: 'shop' });
const callGlobalProductApiReadOnly = (opts) => callShopeeMetaReadOnly({ ...opts, apiType: 'shop' });

function normalizeCategoryRecommendResponse(raw = {}, request_id) {
  const root = raw?.response || raw || {};
  const ids = asArray(root.category_id || root.category_ids || root.categoryid || raw?.category_id);

  const categoryId = ids[0] ?? null;

  return {
    ok: Boolean(categoryId),
    category_id: categoryId ? String(categoryId) : null,
    category_path: categoryId ? String(categoryId) : null,
    confidence: categoryId ? 'auto_top1' : null,
    source: 'dashboard_shopee_api',
    raw_count: ids.length,
    request_id,
  };
}

function normalizeCategoriesResponse(raw = {}, request_id) {
  const rows = asArray(raw?.response?.category_list || raw?.response?.categories || raw?.categories);
  return { ok: rows.length > 0, categories: rows.map(r => ({ category_id: String(r.category_id ?? ''), category_name: r.category_name || r.display_name || '', parent_category_id: r.parent_category_id ?? null, is_leaf: Boolean(r.has_children === false || r.is_leaf), category_path: r.category_path || r.category_name || '' })), request_id };
}

function normalizeAttributesResponse(raw = {}, category_id, request_id) {
  const root = raw?.response || raw || {};
  const list = asArray(root.attribute_tree || root.attribute_list || root.attributes || root.list || root.category_attribute_list || root.children);
  return {
    ok: list.length > 0,
    category_id: category_id || null,
    attributes: list.map(a => ({ attribute_id: String(a.attribute_id ?? a.id ?? ''), attribute_name: a.display_name || a.attribute_name || a.name || '', required: Boolean(a.is_mandatory ?? a.required), input_type: a.input_type || a.value_type || 'TEXT', allowed_values: asArray(a.attribute_value_list || a.options || a.values).map(v => typeof v === 'object' ? (v.original_value_name || v.value || v.name || '') : String(v)), default_value: a.default_value ?? null, review_required: Boolean(a.is_key_attribute ?? a.review_required), source: 'dashboard_shopee_api' })),
    request_id,
  };
}

function normalizeBrandsResponse(raw = {}, category_id, request_id) {
  const rows = asArray(raw?.response?.brand_list || raw?.response?.brands || raw?.brand_list || raw?.brands);
  const brands = rows.map(b => ({ brand_id: String(b.brand_id ?? b.id ?? ''), brand_name: b.original_brand_name || b.brand_name || b.name || '', normalized_name: cleanText((b.original_brand_name || b.brand_name || b.name || '').toLowerCase()) }));
  const no_brand = brands.some(b => b.normalized_name === 'no brand' || b.normalized_name === 'nobrand');
  return { ok: rows.length > 0, category_id: category_id || null, brands, no_brand, request_id };
}

function normalizeDtsLimitResponse(raw = {}, category_id, request_id) {
  const r = raw?.response || raw || {};
  const min = r.min_days_to_ship ?? r.min_dts ?? null;
  const max = r.max_days_to_ship ?? r.max_dts ?? null;
  return { ok: min !== null || max !== null, category_id: category_id || null, min_days_to_ship: min, max_days_to_ship: max, default_days_to_ship: 1, default_allowed: (min === null || 1 >= Number(min)) && (max === null || 1 <= Number(max)), request_id };
}

async function getShopeeMetaStatus({ tenantId }) {
  const request_id = createRequestId('status');
  const db = getDb();
  const [rows] = await db.query(`SELECT region FROM shops WHERE tenant_id = ? AND is_active = 1 AND access_token IS NOT NULL AND access_token <> ''`, [tenantId]);
  const markets = [...new Set(rows.map(r => normalizeMarket(r.region)).filter(Boolean))];
  return { ok: true, metadata_api_available: true, mode: META_MODE, live_enabled: LIVE_ENABLED, active_shop_count: rows.length, markets, endpoints: { category_recommend: true, categories: true, attributes: true, brands: true, dts_limit: true }, request_id };
}

async function recommendCategory({ tenantId, market, name, description }) {
  const request_id = createRequestId('catrec');
  if (!name || !String(name).trim()) return { ok: false, error: 'INVALID_REQUEST', message: 'name is required', request_id };
  if (!LIVE_ENABLED) return disabledResult({ requestId: request_id, apiPath: '/api/v2/product/category_recommend', market, shape: normalizeCategoryRecommendResponse({}, request_id) });
  const call = await callProductApiReadOnly({
    tenantId,
    market,
    path: '/api/v2/product/category_recommend',
    query: {
      item_name: name,
    },
  });
  if (!call.ok) return { ok: false, error: 'CATEGORY_RECOMMEND_FAILED', message: call.message || 'Category recommend failed.', ...normalizeCategoryRecommendResponse({}, request_id), diagnostics: call.diagnostics };
  return { ...normalizeCategoryRecommendResponse(call.data, request_id), diagnostics: call.diagnostics };
}

async function fetchCategories({ tenantId, market }) {
  const request_id = createRequestId('categories');
  if (!LIVE_ENABLED) return disabledResult({ requestId: request_id, apiPath: '/api/v2/product/get_category', market, shape: normalizeCategoriesResponse({}, request_id) });
  const call = await callProductApiReadOnly({ tenantId, market, path: '/api/v2/product/get_category', query: { language: 'en' } });
  const n = normalizeCategoriesResponse(call.data || {}, request_id);
  if (!call.ok || !n.ok) return { ok: false, error: 'CATEGORY_EMPTY_RESPONSE', message: 'Shopee returned an empty category response.', categories: [], request_id, diagnostics: call.diagnostics };
  return { ...n, diagnostics: call.diagnostics };
}

async function fetchAttributes({ tenantId, market, categoryId }) {
  const request_id = createRequestId('attributes');
  if (!LIVE_ENABLED) return disabledResult({ requestId: request_id, apiPath: '/api/v2/product/get_attribute_tree', market, categoryId, shape: normalizeAttributesResponse({}, categoryId, request_id) });
  let call = await callProductApiReadOnly({ tenantId, market, path: '/api/v2/product/get_attribute_tree', query: { category_id: categoryId } });
  let n = normalizeAttributesResponse(call.data || {}, categoryId, request_id);
  if (!n.ok) {
    call = await callProductApiReadOnly({ tenantId, market, path: '/api/v2/product/get_attributes', query: { category_id: categoryId } });
    n = normalizeAttributesResponse(call.data || {}, categoryId, request_id);
  }
  if (!call.ok || !n.ok) return { ok: false, error: 'ATTRIBUTE_EMPTY_RESPONSE', message: 'Shopee returned an empty attribute response.', category_id: categoryId || null, attributes: [], request_id, diagnostics: call.diagnostics };
  return { ...n, diagnostics: call.diagnostics };
}

async function fetchBrands({ tenantId, market, categoryId }) {
  const request_id = createRequestId('brands');
  if (!LIVE_ENABLED) return disabledResult({ requestId: request_id, apiPath: '/api/v2/product/get_brand_list', market, categoryId, shape: normalizeBrandsResponse({}, categoryId, request_id) });
  const call = await callProductApiReadOnly({ tenantId, market, path: '/api/v2/product/get_brand_list', query: { category_id: categoryId } });
  const n = normalizeBrandsResponse(call.data || {}, categoryId, request_id);
  if (!call.ok || !n.ok) return { ok: false, error: 'BRAND_EMPTY_RESPONSE', message: 'Shopee returned an empty brand response.', category_id: categoryId || null, brands: [], no_brand: true, request_id, diagnostics: call.diagnostics };
  return { ...n, diagnostics: call.diagnostics };
}

async function fetchDtsLimit({ tenantId, market, categoryId }) {
  const request_id = createRequestId('dts');
  if (!LIVE_ENABLED) return disabledResult({ requestId: request_id, apiPath: '/api/v2/product/get_dts_limit', market, categoryId, shape: normalizeDtsLimitResponse({}, categoryId, request_id) });
  const call = await callProductApiReadOnly({ tenantId, market, path: '/api/v2/product/get_dts_limit', query: { category_id: categoryId } });
  const n = normalizeDtsLimitResponse(call.data || {}, categoryId, request_id);
  if (!call.ok || !n.ok) return { ok: false, error: 'DTS_LIMIT_EMPTY_RESPONSE', message: 'Shopee returned an empty dts limit response.', ...normalizeDtsLimitResponse({}, categoryId, request_id), diagnostics: call.diagnostics };
  return { ...n, diagnostics: call.diagnostics };
}

function runSelfTest() {
  const s = sanitizeObjectForMetaResponse({ access_token: 'x', nested: { sign: 'y', keep: 1 } });
  const passSanitize = !JSON.stringify(s).includes('access_token') && !JSON.stringify(s).includes('sign');
  const passRec = normalizeCategoryRecommendResponse({ response: { category_list: [{ category_id: 101790, category_name: 'A' }] } }, 'r').category_id === '101790';
  const passCat = normalizeCategoriesResponse({ response: { category_list: [{ category_id: 1, category_name: 'C', has_children: false }] } }, 'r').categories.length === 1;
  const passAttr = normalizeAttributesResponse({ response: { attribute_list: [{ attribute_id: 1, attribute_name: 'Color', is_mandatory: true }] } }, '1', 'r').attributes[0].required === true;
  const passBrand = normalizeBrandsResponse({ response: { brand_list: [{ brand_id: 0, brand_name: 'No Brand' }] } }, '1', 'r').no_brand === true;
  const passDts = normalizeDtsLimitResponse({ response: { min_days_to_ship: 0, max_days_to_ship: 3 } }, '1', 'r').default_allowed === true;
  const passDisabled = LIVE_ENABLED === false;
  const report = { ok: passSanitize && passRec && passCat && passAttr && passBrand && passDts && passDisabled, passSanitize, passRec, passCat, passAttr, passBrand, passDts, passDisabled };
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
if (require.main === module && process.argv.includes('--self-test')) runSelfTest();

module.exports = { sanitizeObjectForMetaResponse, selectActiveShopForMetadata, callShopeeMetaReadOnly, callProductApiReadOnly, callGlobalProductApiReadOnly, normalizeCategoryRecommendResponse, normalizeCategoriesResponse, normalizeAttributesResponse, normalizeBrandsResponse, normalizeDtsLimitResponse, getShopeeMetaStatus, recommendCategory, fetchCategories, fetchAttributes, fetchBrands, fetchDtsLimit };
