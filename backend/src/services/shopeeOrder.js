/**
 * Shopee 주문 API 서비스
 * - get_order_list  (cursor 페이지네이션)
 * - get_order_detail (50건 batch)
 * - get_escrow_detail (수수료 조회)
 *
 * 주의사항:
 * - shop별 access_token (getOrRefreshShopToken) + shop_id 파라미터로 샵 지정
 * - Shopee API 필드명 그대로 사용 (변환 금지)
 * - create_time(unix) → KST(UTC+9) 변환하여 order_created_at 저장
 */

const { buildUrl } = require('../utils/shopeeSignature');
const { callWithRetry, shopeeAxios, sleep } = require('../utils/apiWrapper');
const { refreshShopToken } = require('./shopeeAuth');

// shop별 onAuthError 핸들러 — 403 발생 시 해당 shop 토큰만 갱신
function makeAuthErrorHandler(shopId) {
  return async () => {
    console.log(`[ShopeeOrder] Auth/403 detected (shop_id=${shopId}), refreshing shop token...`);
    const ok = await refreshShopToken(shopId);
    if (!ok) {
      console.error(`[ShopeeOrder] refreshShopToken(${shopId}) failed — Re-auth required.`);
    }
  };
}

/**
 * URL 재서명 팩토리 (rebuildRequest용)
 * 토큰 갱신 후 새 access_token으로 URL을 재생성해 requestFn을 교체한다.
 *
 * @param {string}       method   - 'get' | 'post'
 * @param {string}       path     - e.g. '/api/v2/order/get_order_list'
 * @param {object}       params   - URL 쿼리 파라미터 (buildUrl의 params 인자)
 * @param {string}       urlType  - 'shop' | 'merchant' | 'public'
 * @param {string|number} id      - shop_id 또는 merchant_id
 * @param {object|null}  body     - POST body (GET이면 null)
 * @returns {Function}  rebuildRequest = async (newToken) => () => axiosResponse
 */
function makeRebuildRequest(method, path, params, urlType, id, body = null) {
  return async (newAccessToken) => {
    const newUrl = buildUrl(path, params, urlType, newAccessToken, id);
    if (method === 'post') {
      return () => shopeeAxios.post(newUrl, body);
    }
    return () => shopeeAxios.get(newUrl);
  };
}

// ─── unix timestamp → KST datetime string ───────────────────────
function unixToKST(unixSec) {
  if (!unixSec) return null;
  const d = new Date(unixSec * 1000 + 9 * 3600 * 1000);
  // MySQL DATETIME 형식
  return d.toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
}

// ─── get_order_list (cursor 기반 전체 수집) ─────────────────────
/**
 * @param {number} shopId
 * @param {number} timeFrom  unix seconds
 * @param {number} timeTo    unix seconds
 * @param {string} accessToken
 * @returns {string[]} order_sn 배열
 */
async function getOrderList(shopId, timeFrom, timeTo, accessToken) {
  const path = '/api/v2/order/get_order_list';
  let cursor = '';
  let allOrderSns = [];
  let page = 0;

  while (true) {
    page++;
    const params = {
      time_range_field: 'create_time',
      time_from: String(timeFrom),
      time_to: String(timeTo),
      page_size: '100',
    };
    if (cursor) params.cursor = cursor;

    const url = buildUrl(path, params, 'shop', accessToken, shopId);

    const data = await callWithRetry(
      () => shopeeAxios.get(url),
      {
        context: `get_order_list[shop=${shopId}][page=${page}]`,
        onAuthError: makeAuthErrorHandler(shopId),
        rebuildRequest: makeRebuildRequest('get', path, params, 'shop', shopId),
      }
    );

    if (data.error && data.error !== '') {
      throw new Error(`get_order_list error: ${data.error} - ${data.message}`);
    }

    const resp = data.response || {};
    const orderList = resp.order_list || [];
    allOrderSns.push(...orderList.map(o => o.order_sn));

    if (!resp.more || !resp.next_cursor) break;
    cursor = resp.next_cursor;

    // Rate limit 보호: 100건 이상 페이지가 있을 경우 0.5초 딜레이
    await sleep(500);
  }

  return allOrderSns;
}

// ─── get_order_detail (50건 batch) ──────────────────────────────
/**
 * @param {number} shopId
 * @param {string[]} orderSnList
 * @param {string} accessToken
 * @returns {object[]} 주문 상세 배열
 */
async function getOrderDetail(shopId, orderSnList, accessToken) {
  if (!orderSnList.length) return [];

  const path = '/api/v2/order/get_order_detail';
  const BATCH = 50;
  const results = [];

  for (let i = 0; i < orderSnList.length; i += BATCH) {
    const batch = orderSnList.slice(i, i + BATCH);
    const params = {
      order_sn_list: batch.join(','),
      // 필요한 optional 필드 전부 요청
      response_optional_fields: [
        'buyer_user_id',
        'buyer_username',
        'estimated_shipping_fee',
        'recipient_address',
        'actual_shipping_fee',
        'goods_to_declare',
        'note',
        'note_update_time',
        'pay_time',
        'dropshipper',
        'dropshipper_phone',
        'split_up',
        'buyer_cancel_reason',
        'cancel_by',
        'cancel_reason',
        'actual_shipping_fee_confirmed',
        'buyer_cpf_id',
        'fulfillment_flag',
        'pickup_done_time',
        'package_list',
        'shipping_carrier',
        'payment_method',
        'total_amount',
        'buyer_username',
        'invoice_data',
        'checkout_shipping_carrier',
        'reverse_shipping_fee',
        'order_chargeable_weight_gram',
        'edt',
        'prescription_images',
        'prescription_check_status',
        'cod_pay_type',
        'merchant_data',
        'item_list',
      ].join(','),
    };

    const url = buildUrl(path, params, 'shop', accessToken, shopId);

    const data = await callWithRetry(
      () => shopeeAxios.get(url),
      {
        context: `get_order_detail[shop=${shopId}][batch=${Math.floor(i / BATCH) + 1}]`,
        onAuthError: makeAuthErrorHandler(shopId),
        rebuildRequest: makeRebuildRequest('get', path, params, 'shop', shopId),
      }
    );

    if (data.error && data.error !== '') {
      throw new Error(`get_order_detail error: ${data.error} - ${data.message}`);
    }

    const orders = data.response?.order_list || [];
    results.push(...orders);

    if (orderSnList.length > BATCH) await sleep(300);
  }

  return results;
}

// ─── get_escrow_detail (수수료 조회) ────────────────────────────
/**
 * @param {number} shopId
 * @param {string} orderSn
 * @param {string} accessToken
 * @returns {object|null}
 */
async function getEscrowDetail(shopId, orderSn, accessToken) {
  const path = '/api/v2/payment/get_escrow_detail';
  const params = { order_sn: orderSn };
  const url = buildUrl(path, params, 'shop', accessToken, shopId);

  try {
    const data = await callWithRetry(
      () => shopeeAxios.get(url),
      {
        context: `get_escrow_detail[shop=${shopId}][${orderSn}]`,
        onAuthError: makeAuthErrorHandler(shopId),
        rebuildRequest: makeRebuildRequest('get', path, params, 'shop', shopId),
      }
    );

    if (data.error && data.error !== '') {
      // 비즈니스 에러는 null 반환 (스킵)
      console.warn(`[get_escrow_detail] ${orderSn}: ${data.error} - ${data.message}`);
      return null;
    }

    if (orderSn === '26042814WW388A') {
      const response = data.response || {};
      const buyerPaymentInfo = response.buyer_payment_info || {};
      const orderIncome = response.order_income || {};

      console.log('[EscrowDiag][26042814WW388A]', JSON.stringify({
        buyer_payment_info_keys: Object.keys(buyerPaymentInfo),
        buyer_payment_info_merchandise_subtotal: buyerPaymentInfo.merchandise_subtotal,
        buyer_payment_info_merchant_subtotal: buyerPaymentInfo.merchant_subtotal,
        order_income_keys: Object.keys(orderIncome),
        order_income_escrow_amount: orderIncome.escrow_amount,
        order_income_original_price: orderIncome.original_price,
        order_income_items_sample: (orderIncome.items || []).slice(0, 5).map(item => ({
          item_id: item.item_id,
          quantity_purchased: item.quantity_purchased,
          discounted_price: item.discounted_price,
          original_price: item.original_price,
        })),
      }));
    }

    return data.response || null;
  } catch (err) {
    if (err.isBusinessError) return null;
    throw err;
  }
}

// ─── get_tracking_number (운송장번호 조회) ───────────────────────
/**
 * v2.logistics.get_tracking_number
 * @param {number} shopId
 * @param {string} orderSn
 * @param {string} accessToken
 * @returns {string|null}  tracking_number 문자열 또는 null
 */
async function getTrackingNumber(shopId, orderSn, accessToken) {
  const path = '/api/v2/logistics/get_tracking_number';
  const params = { order_sn: orderSn };
  const url = buildUrl(path, params, 'shop', accessToken, shopId);

  try {
    const data = await callWithRetry(
      () => shopeeAxios.get(url),
      {
        context: `get_tracking_number[shop=${shopId}][${orderSn}]`,
        onAuthError: makeAuthErrorHandler(shopId),
        rebuildRequest: makeRebuildRequest('get', path, params, 'shop', shopId),
      }
    );

    if (data.error && data.error !== '') {
      console.warn(`[get_tracking_number] ${orderSn}: ${data.error} - ${data.message}`);
      return null;
    }

    const tn = data.response?.tracking_number;
    return tn || null;
  } catch (err) {
    if (err.isBusinessError) return null;
    throw err;
  }
}

// ─── 주문 데이터 → DB 행 변환 ────────────────────────────────────
/**
 * get_order_detail 응답 1건을 orders/order_items INSERT용으로 변환
 * @param {object} order - API 응답의 order 객체
 * @param {number} shopId
 * @param {string} region  - 샵의 region
 * @param {object|null} escrow - get_escrow_detail 응답 (없으면 null)
 */
function mapOrderToDb(order, shopId, region, escrow) {
  // ─ 수수료 필드 우선순위: escrow > order 직접 필드
  const income = escrow?.order_income || {};

  const itemList = order.item_list || [];

  const buyerPaymentInfo = escrow?.buyer_payment_info || {};
  const buyerPaymentSubtotal = parseFloat(
    buyerPaymentInfo.merchandise_subtotal ??
    buyerPaymentInfo.merchant_subtotal ??
    0
  );
  const merchandise_subtotal = buyerPaymentSubtotal || null;

  const orderRow = {
    shop_id: shopId,
    region: region,
    order_sn: order.order_sn,
    order_status: order.order_status,
    buyer_user_id: order.buyer_user_id ?? null,
    buyer_username: order.buyer_username ?? null,
      display_status: order.display_status ?? order.order_status,
      display_status_reason: order.display_status_reason ?? null,
      display_status_checked_at: order.display_status_checked_at ?? null,
    is_final_status: ['COMPLETED', 'CANCELLED'].includes(order.order_status) ? 1 : 0,
    merchandise_subtotal: merchandise_subtotal,
    total_amount: order.total_amount ?? null,
    currency: order.currency ?? null,
    original_price: income.original_price ?? null,
    seller_discount: income.seller_discount ?? null,
    voucher_from_seller: income.voucher_from_seller ?? null,
    voucher_from_shopee: income.voucher_from_shopee ?? null,
    coins_offset: income.coins_offset ?? null,
    buyer_total_amount: income.buyer_total_amount ?? null,
    payment_method: order.payment_method ?? null,
    shipping_carrier: order.shipping_carrier ?? null,
    checkout_shipping_carrier: order.checkout_shipping_carrier ?? null,
    tracking_number: order.tracking_no ?? null,
    shipping_fee: buyerPaymentInfo.shipping_fee ?? income.shipping_fee ?? null,
    shipping_fee_discount: income.shipping_fee_discount ?? null,
    actual_shipping_fee: order.actual_shipping_fee ?? income.actual_shipping_fee ?? null,
    estimated_shipping_fee: order.estimated_shipping_fee ?? null,
    order_chargeable_weight_gram: order.order_chargeable_weight_gram ?? null,
    commission_fee: income.commission_fee ?? null,
    service_fee: income.service_fee ?? null,
    transaction_fee:
      income.seller_transaction_fee ??
      income.ams_commission_fee ??
      income.transaction_fee ??
      null,
    escrow_amount: income.escrow_amount ?? null,
    create_time: order.create_time ?? null,
    order_created_at: order.create_time ? unixToKST(order.create_time) : null,
    update_time: order.update_time ?? null,
  };

  // order_items
  const itemRows = itemList.map(item => ({
    order_sn: order.order_sn,
    shop_id: shopId,
    item_id: item.item_id ?? null,
    item_name: item.item_name ?? null,
    item_sku: item.item_sku ?? null,
    model_id: item.model_id ?? null,
    model_name: item.model_name ?? null,
    model_sku: item.model_sku ?? null,
    model_quantity_purchased: item.model_quantity_purchased ?? null,
    model_original_price: item.model_original_price ?? null,
    model_discounted_price: item.model_discounted_price ?? null,
    image_info_image_url: item.image_info?.image_url ?? null,
    item_image_url: item.image_info?.image_url ?? null,
  }));

  return { orderRow, itemRows };
}

// ─── 업데이트할 필드만 비교 ──────────────────────────────────────
// 수동 동기화 Step2: 기존 주문 업데이트 대상 필드
const UPDATE_FIELDS = [
  'order_status',
  'buyer_user_id',
  'buyer_username',
  'display_status',
  'display_status_reason',
  'merchandise_subtotal',
  'original_price',
  'seller_discount',
  'voucher_from_seller',
  'voucher_from_shopee',
  'coins_offset',
  'buyer_total_amount',
  'payment_method',
  'shipping_carrier',
  'checkout_shipping_carrier',
  'actual_shipping_fee',
  'order_chargeable_weight_gram',
  'commission_fee',
  'service_fee',
  'transaction_fee',
  'escrow_amount',
  'tracking_number',
  'is_final_status',
  'update_time',
];

/**
 * DB 행과 신규 데이터 비교 → 변경된 필드만 반환
 */
function diffOrderRow(dbRow, newRow) {
  const diff = {};
  const nullSafeFields = new Set([
    'escrow_amount',
    'merchandise_subtotal',
    'original_price',
    'seller_discount',
    'voucher_from_seller',
    'voucher_from_shopee',
    'coins_offset',
    'buyer_total_amount',
    'buyer_user_id',
    'buyer_username',
  ]);

  for (const field of UPDATE_FIELDS) {
    const dbVal = dbRow[field] === null ? null : String(dbRow[field]);
    const newVal = newRow[field] === null ? null : String(newRow[field]);

    if (dbVal !== newVal) {
      if (nullSafeFields.has(field) && newVal === null && dbVal !== null) continue;
      diff[field] = newRow[field];
    }
  }

  return diff;
}


module.exports = {
  getOrderList,
  getOrderDetail,
  getEscrowDetail,
  getTrackingNumber,
  mapOrderToDb,
  diffOrderRow,
  unixToKST,
  UPDATE_FIELDS,
};
