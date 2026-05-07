/**
 * Shopee API 연결 테스트 라우트
 * GET /api/test/shopee-connection  - 3개 활성 샵 연결 상태 확인
 * GET /api/test/shopee-connection/:shopId - 특정 샵 테스트
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { buildUrl } = require('../utils/shopeeSignature');
const { callWithRetry, shopeeAxios } = require('../utils/apiWrapper');
const { getMainAccount } = require('../services/shopeeAuth');
const db = require('../config/database');
const { CURRENT_TENANT_ID } = require('../config/tenant');

router.use(requireAuth);

// ─── 유틸: 오늘 0시 KST → UTC Unix ──────────────────────────────
function getTodayRangeUnix() {
  // KST 오늘 0시 = UTC 전날 15:00
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);

  // KST 오늘 00:00:00
  const kstMidnight = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), 0, 0, 0)
  );
  // UTC로 변환 (KST 0시 = UTC -9시간)
  const utcMidnight = new Date(kstMidnight.getTime() - kstOffset);

  return {
    time_from: Math.floor(utcMidnight.getTime() / 1000),
    time_to: Math.floor(now.getTime() / 1000),
  };
}

// ─── 단일 샵 get_order_list 호출 ─────────────────────────────────
async function testShopConnection(shopId, accessToken) {
  const path = '/api/v2/order/get_order_list';
  const { time_from, time_to } = getTodayRangeUnix();

  const url = buildUrl(
    path,
    {
      time_range_field: 'create_time',
      time_from: String(time_from),
      time_to: String(time_to),
      page_size: '10',
    },
    'shop',
    accessToken,
    shopId
  );

  const startMs = Date.now();

  try {
    const data = await callWithRetry(
      () => shopeeAxios.get(url),
      { context: `TestShop-${shopId}` }
    );

    const elapsedMs = Date.now() - startMs;

    return {
      shop_id: shopId,
      success: true,
      error: data.error || '',
      message: data.message || '',
      request_id: data.request_id || '',
      order_count: data.response?.order_list?.length ?? 0,
      total_count: data.response?.total_count ?? 0,
      more: data.response?.more ?? false,
      raw_response: data,
      elapsed_ms: elapsedMs,
      time_from,
      time_to,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    const errData = err.response?.data || {};

    return {
      shop_id: shopId,
      success: false,
      error: errData.error || err.message || 'NETWORK_ERROR',
      message: errData.message || err.message || '',
      request_id: errData.request_id || '',
      order_count: 0,
      raw_response: errData,
      elapsed_ms: elapsedMs,
      time_from,
      time_to,
    };
  }
}

// ─── GET /api/test/shopee-connection ─────────────────────────────
// 활성 3개 샵 전부 테스트
router.get('/shopee-connection', async (req, res) => {
  // main_account 토큰 조회
  const account = await getMainAccount({ tenantId: CURRENT_TENANT_ID });

  if (!account || !account.access_token) {
    return res.json({
      success: false,
      error: 'NO_TOKEN',
      message: 'Shopee 인증이 필요합니다. 설정 화면에서 [Shopee 인증] 버튼을 클릭하세요.',
      results: [],
    });
  }

  // 활성 샵 목록 조회 (is_active = 1)
  const [activeShops] = await db.query(
    'SELECT shop_id, alias, region FROM shops WHERE tenant_id = ? AND is_active = 1 ORDER BY id ASC',
    [CURRENT_TENANT_ID]
  );

  if (activeShops.length === 0) {
    return res.json({
      success: false,
      error: 'NO_ACTIVE_SHOPS',
      message: '활성화된 샵이 없습니다.',
      results: [],
    });
  }

  // 병렬로 모든 활성 샵 테스트
  const results = await Promise.all(
    activeShops.map(shop =>
      testShopConnection(shop.shop_id, account.access_token).then(result => ({
        ...result,
        alias: shop.alias,
        region: shop.region,
      }))
    )
  );

  const allSuccess = results.every(r => r.success && r.error === '');
  const anySuccess = results.some(r => r.success && r.error === '');

  return res.json({
    success: allSuccess,
    partial_success: anySuccess && !allSuccess,
    token_status: account.token_status,
    token_expires_at: account.token_expires_at,
    tested_at: new Date().toISOString(),
    results,
  });
});

// ─── GET /api/test/shopee-connection/:shopId ──────────────────────
// 특정 샵만 테스트
router.get('/shopee-connection/:shopId', async (req, res) => {
  const { shopId } = req.params;

  const account = await getMainAccount({ tenantId: CURRENT_TENANT_ID });
  if (!account || !account.access_token) {
    return res.json({
      success: false,
      error: 'NO_TOKEN',
      message: 'Shopee 인증이 필요합니다.',
    });
  }

  const [shopRows] = await db.query(
    'SELECT shop_id, alias, region FROM shops WHERE tenant_id = ? AND shop_id = ?',
    [CURRENT_TENANT_ID, shopId]
  );

  const result = await testShopConnection(shopId, account.access_token);
  const shopInfo = shopRows[0] || {};

  return res.json({
    ...result,
    alias: shopInfo.alias,
    region: shopInfo.region,
  });
});

// ─── GET /api/test/order-detail/:orderSn ─────────────────────────
// 특정 주문의 Shopee API 실제 응답 전문 확인 (진단용)
router.get('/order-detail/:orderSn', async (req, res) => {
  const { orderSn } = req.params;

  const account = await getMainAccount({ tenantId: CURRENT_TENANT_ID });
  if (!account || !account.access_token) {
    return res.json({ success: false, error: 'NO_TOKEN', message: 'Shopee 인증이 필요합니다.' });
  }

  // DB에서 해당 주문의 shop_id 조회
  const [dbRows] = await db.query(
    `SELECT order_sn, shop_id, region, order_status, is_final_status,
            merchandise_subtotal, total_amount, update_time, synced_at
     FROM orders WHERE tenant_id = ? AND order_sn = ? LIMIT 1`,
    [CURRENT_TENANT_ID, orderSn]
  );

  if (!dbRows.length) {
    return res.json({ success: false, error: 'ORDER_NOT_FOUND', message: `DB에 ${orderSn} 주문이 없습니다.` });
  }

  const dbOrder = dbRows[0];
  const shopId = dbOrder.shop_id;

  console.log(`[DiagOrderDetail] order_sn=${orderSn} shop_id=${shopId} DB_status=${dbOrder.order_status}`);

  // Shopee API get_order_detail 직접 호출
  const path = '/api/v2/order/get_order_detail';
  const params = {
    order_sn_list: orderSn,
    response_optional_fields: [
      'item_list', 'total_amount', 'actual_shipping_fee', 'payment_method',
      'fulfillment_flag', 'cod_pay_type', 'cancel_reason', 'buyer_cancel_reason',
      'order_chargeable_weight_gram', 'shipping_carrier', 'checkout_shipping_carrier',
      'package_list', 'note',
    ].join(','),
  };

  const url = buildUrl(path, params, 'shop', account.access_token, shopId);

  try {
    const data = await callWithRetry(
      () => shopeeAxios.get(url),
      { context: `DiagOrderDetail-${orderSn}` }
    );

    const apiOrder = data.response?.order_list?.[0] || null;

    console.log(`[DiagOrderDetail] Shopee API 응답:`);
    console.log(`  error: ${data.error || 'none'}`);
    console.log(`  order_status: ${apiOrder?.order_status}`);
    console.log(`  fulfillment_flag: ${apiOrder?.fulfillment_flag}`);
    console.log(`  cod_pay_type: ${apiOrder?.cod_pay_type}`);
    console.log(`  payment_method: ${apiOrder?.payment_method}`);
    console.log(`  cancel_reason: ${apiOrder?.cancel_reason}`);
    console.log(`  update_time: ${apiOrder?.update_time}`);
    console.log(`  전체 응답 필드: ${apiOrder ? Object.keys(apiOrder).join(', ') : 'null'}`);

    return res.json({
      success: true,
      db_record: dbOrder,
      shopee_api: {
        error: data.error || '',
        message: data.message || '',
        request_id: data.request_id || '',
        // 핵심 상태 필드
        order_status:        apiOrder?.order_status,
        fulfillment_flag:    apiOrder?.fulfillment_flag,
        cod_pay_type:        apiOrder?.cod_pay_type,
        payment_method:      apiOrder?.payment_method,
        cancel_reason:       apiOrder?.cancel_reason,
        buyer_cancel_reason: apiOrder?.buyer_cancel_reason,
        actual_shipping_fee: apiOrder?.actual_shipping_fee,
        update_time:         apiOrder?.update_time,
        // 전체 원본 응답
        raw: apiOrder,
      },
    });
  } catch (err) {
    console.error(`[DiagOrderDetail] 오류:`, err.message);
    return res.status(500).json({ success: false, error: err.message, db_record: dbOrder });
  }
});

module.exports = router;
