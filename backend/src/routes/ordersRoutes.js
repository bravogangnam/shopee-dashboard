/**
 * 주문 관련 API 라우트
 * GET /api/orders              - 주문 목록 (필터, 페이지네이션)
 * GET /api/orders/:orderSn     - 주문 상세 (items 포함)
 * GET /api/orders/stats        - 집계 통계 (대시보드용)
 * GET /api/orders/summary      - 간단 요약 (카드 표시용)
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');

router.use(requireAuth);

/**
 * GET /api/orders
 * Query params:
 *   page (default 1), page_size (default 20, max 100)
 *   shop_id, region, order_status
 *   date_from, date_to  (KST YYYY-MM-DD)
 *   order_sn  (부분 검색)
 */
router.get('/', async (req, res) => {
  const {
    page = 1,
    page_size = 20,
    shop_id,
    region,
    order_status,
    date_from,
    date_to,
    order_sn: orderSnSearch,
  } = req.query;

  const pageNum = Math.max(1, parseInt(page));
  const pageSize = Math.min(100, Math.max(1, parseInt(page_size)));
  const offset = (pageNum - 1) * pageSize;

  // ── 요청 파라미터 로그 ────────────────────────────────────────
  console.log(`[Orders] REQ page=${pageNum} pageSize=${pageSize} offset=${offset} | filters: region=${region||'-'} status=${order_status||'-'} date=${date_from||'-'}~${date_to||'-'} sn=${orderSnSearch||'-'}`);
  if (date_from || date_to) {
    console.log(`[Orders] DATE filter → WHERE order_created_at >= '${date_from||''}  00:00:00' AND <= '${date_to||''} 23:59:59' (KST 기준)`);
  }

  // 활성 샵 기반 필터
  let whereClause = `o.shop_id IN (SELECT shop_id FROM shops WHERE is_active = 1)`;
  const params = [];

  if (shop_id) {
    whereClause += ` AND o.shop_id = ?`;
    params.push(shop_id);
  }

  if (region) {
    whereClause += ` AND o.region = ?`;
    params.push(region);
  }

  if (order_status) {
    // 쉼표 구분 여러 상태 허용
    const statuses = order_status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      whereClause += ` AND o.order_status = ?`;
      params.push(statuses[0]);
    } else if (statuses.length > 1) {
      const placeholders = statuses.map(() => '?').join(',');
      whereClause += ` AND o.order_status IN (${placeholders})`;
      params.push(...statuses);
    }
  }

  if (date_from) {
    // order_created_at은 KST 문자열로 저장 → KST 기준 필터
    whereClause += ` AND o.order_created_at >= ?`;
    params.push(`${date_from} 00:00:00`);
  }

  if (date_to) {
    // order_created_at은 KST 문자열로 저장 → KST 기준 필터
    whereClause += ` AND o.order_created_at <= ?`;
    params.push(`${date_to} 23:59:59`);
  }

  if (orderSnSearch) {
    whereClause += ` AND o.order_sn LIKE ?`;
    params.push(`%${orderSnSearch}%`);
  }

  try {
    // ── STEP 1: orders 테이블 기준 COUNT (JOIN 없음 → row 뻥튀기 없음) ──
    const [countRows] = await db.query(
      `SELECT COUNT(*) as total FROM orders o WHERE ${whereClause}`,
      params
    );
    const total = countRows[0].total;
    console.log(`[Orders] COUNT total=${total} total_pages=${Math.ceil(total/pageSize)}`);

    // ── STEP 2: orders.id 만 페이지네이션
    // ORDER BY order_created_at(KST) - 필터 컬럼과 동일 기준으로 정렬해야 OFFSET이 정확함
    // create_time(UTC unix)으로 정렬하면 KST 필터 범위와 9시간 불일치 → 페이지 경계에서 누락 발생
    const [pageIds] = await db.query(
      `SELECT o.id, o.order_created_at
       FROM orders o
       WHERE ${whereClause}
       ORDER BY o.order_created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    console.log(`[Orders] STEP2 pageIds.length=${pageIds.length} (expected=${Math.min(pageSize, Math.max(0, total-offset))}) ORDER BY order_created_at DESC`);
    if (pageIds.length > 0) {
      console.log(`[Orders] STEP2 first=${pageIds[0].order_created_at} last=${pageIds[pageIds.length-1].order_created_at}`);
    }

    if (pageIds.length === 0) {
      console.log(`[Orders] EMPTY page returned → page=${pageNum} offset=${offset} total=${total}`);
      return res.json({
        success: true,
        data: [],
        pagination: { page: pageNum, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
      });
    }

    // ── STEP 3: 해당 ID들의 상세 정보 조회 (JOIN은 여기서만) ──
    const idList = pageIds.map(r => r.id);
    const idPlaceholders = idList.map(() => '?').join(',');

    const [orders] = await db.query(
      `SELECT
        o.id, o.shop_id, o.region, o.order_sn, o.order_status, o.is_final_status,
        o.merchandise_subtotal, o.total_amount, o.currency,
        o.original_price, o.seller_discount, o.voucher_from_seller, o.voucher_from_shopee,
        o.coins_offset, o.buyer_total_amount,
        o.shipping_carrier, o.tracking_number, o.shipping_fee, o.shipping_fee_discount,
        o.actual_shipping_fee, o.estimated_shipping_fee, o.order_chargeable_weight_gram,
        o.commission_fee, o.service_fee, o.transaction_fee, o.escrow_amount,
        o.create_time, o.order_created_at, o.update_time, o.synced_at,
        s.alias as shop_alias,
        r.rate_to_krw as krw_rate
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       LEFT JOIN exchange_rates r ON o.currency = r.currency
       WHERE o.id IN (${idPlaceholders})
       ORDER BY o.order_created_at DESC`,
      idList
    );

    // ── STEP 4: order_items 별도 조회 (해당 페이지 주문들만) ──
    const orderSnList = orders.map(o => o.order_sn);
    const snPlaceholders = orderSnList.map(() => '?').join(',');
    const [items] = await db.query(
      `SELECT order_sn, item_id, item_name, item_sku, model_id, model_name, model_sku,
              model_quantity_purchased, model_original_price, model_discounted_price,
              image_info_image_url, item_image_url
       FROM order_items
       WHERE order_sn IN (${snPlaceholders})
       ORDER BY id ASC`,
      orderSnList
    );

    const itemsByOrderSn = {};
    for (const item of items) {
      if (!itemsByOrderSn[item.order_sn]) itemsByOrderSn[item.order_sn] = [];
      itemsByOrderSn[item.order_sn].push(item);
    }

    // ── STEP 5: merchandise_subtotal enrichment ──
    // DB의 merchandise_subtotal을 우선 사용.
    // Shopee 묶음할인 시 disc=0인 행이 있어 item 합산은 부정확 → 절대 item 합산 fallback 사용 안 함.
    // subtotal 없으면 total_amount fallback.
    const enrichedOrders = orders.map(o => {
      const its = itemsByOrderSn[o.order_sn] || [];
      const subtotal = parseFloat(o.merchandise_subtotal || 0) || null;
      return {
        ...o,
        merchandise_subtotal: subtotal || o.total_amount || null,
        item_list: its,
      };
    });

    console.log(`[Orders] RES page=${pageNum} returned=${enrichedOrders.length} rows | total=${total}`);

    return res.json({
      success: true,
      data: enrichedOrders,
      pagination: {
        page: pageNum,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error('[OrdersRoute] list error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/stats
 * 매출 통계 (대시보드 카드용)
 * Query:
 *   date_from, date_to (YYYY-MM-DD, KST 기준) - 없으면 이번달
 *   shop_id (optional)
 */
router.get('/stats', async (req, res) => {
  const { date_from, date_to, shop_id } = req.query;

  // ── 날짜 범위 결정 ─────────────────────────────────────────────
  // 기본값: 이번달 1일 ~ 오늘 (KST)
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 3600 * 1000);
  const kstYear  = kstNow.getUTCFullYear();
  const kstMonth = kstNow.getUTCMonth() + 1; // 1-based
  const kstDay   = kstNow.getUTCDate();
  const defaultFrom = `${kstYear}-${String(kstMonth).padStart(2,'0')}-01`;
  const defaultTo   = `${kstYear}-${String(kstMonth).padStart(2,'0')}-${String(kstDay).padStart(2,'0')}`;

  const rangeFrom = date_from || defaultFrom;
  const rangeTo   = date_to   || defaultTo;

  // ── 전월 동일 기간 계산 ────────────────────────────────────────
  // 규칙: 선택 기간의 각 날짜를 전월 동일 날짜로 이동
  //   예1) 4/1~4/15  → 3/1~3/15
  //   예2) 4/10~4/15 → 3/10~3/15
  //   예3) 3/31      → 2/28 (전월 말일 클램프)
  const clampToMonthEnd = (year, month, day) => {
    // month: 1-based, 해당 월의 마지막 날짜 반환
    const lastDay = new Date(year, month, 0).getDate(); // month는 0-based에서 다음달 0일
    return Math.min(day, lastDay);
  };

  const shiftToPrevMonth = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    let prevYear  = m === 1 ? y - 1 : y;
    let prevMonth = m === 1 ? 12 : m - 1;
    let prevDay   = clampToMonthEnd(prevYear, prevMonth, d);
    return `${prevYear}-${String(prevMonth).padStart(2,'0')}-${String(prevDay).padStart(2,'0')}`;
  };

  const prevFrom = shiftToPrevMonth(rangeFrom);
  const prevTo   = shiftToPrevMonth(rangeTo);

  console.log(`[Stats] 기간: ${rangeFrom}~${rangeTo} | 전월비교: ${prevFrom}~${prevTo}`);

  // ── 필터 빌더 ──────────────────────────────────────────────────
  const shopFilter = `AND o.shop_id IN (SELECT shop_id FROM shops WHERE is_active = 1)${shop_id ? ' AND o.shop_id = ?' : ''}`;
  const shopParams = shop_id ? [shop_id] : [];

  const buildDateFilter = (f, t) =>
    `AND o.order_created_at >= '${f} 00:00:00' AND o.order_created_at <= '${t} 23:59:59'`;

  const curFilter  = buildDateFilter(rangeFrom, rangeTo);
  const prevFilter = buildDateFilter(prevFrom, prevTo);

  // 매출 포함 상태: READY_TO_SHIP, PROCESSED, SHIPPED, COMPLETED, TO_CONFIRM_RECEIVE
  // 매출 제외 상태: UNPAID, PENDING, CANCELLED
  const EXCLUDED_STATUSES = `'UNPAID', 'PENDING', 'CANCELLED'`;

  const salesQuery = (dateFilter) => `
    SELECT
      o.region, o.currency, r.rate_to_krw,
      COUNT(*) as order_count,
      SUM(CASE WHEN o.order_status NOT IN (${EXCLUDED_STATUSES}) THEN 1 ELSE 0 END) as valid_count,
      SUM(CASE WHEN o.order_status NOT IN (${EXCLUDED_STATUSES}) THEN
        COALESCE(o.merchandise_subtotal, 0) ELSE 0 END) as total_sales,
      SUM(CASE WHEN o.order_status NOT IN (${EXCLUDED_STATUSES}) THEN
        COALESCE(o.escrow_amount, 0) ELSE 0 END) as total_escrow,
      SUM(CASE WHEN o.order_status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_count,
      SUM(CASE WHEN o.order_status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled_count,
      SUM(CASE WHEN o.order_status IN ('READY_TO_SHIP', 'PROCESSED', 'SHIPPED') THEN 1 ELSE 0 END) as in_progress_count
    FROM orders o
    LEFT JOIN exchange_rates r ON o.currency = r.currency
    WHERE 1=1 ${shopFilter} ${dateFilter}
    GROUP BY o.region, o.currency, r.rate_to_krw
  `;

  try {
    // ── SQL 로그: 실제 실행 쿼리 확인 ─────────────────────────────
    const curSqlFull  = salesQuery(curFilter).replace(/\s+/g, ' ').trim();
    const prevSqlFull = salesQuery(prevFilter).replace(/\s+/g, ' ').trim();
    console.log(`[Stats SQL] 현재기간 쿼리:\n  ${curSqlFull}`);
    console.log(`[Stats SQL] 전월기간 쿼리:\n  ${prevSqlFull}`);
    console.log(`[Stats SQL] shopParams: ${JSON.stringify(shopParams)}`);

    const [curRows]  = await db.query(salesQuery(curFilter),  shopParams);
    const [prevRows] = await db.query(salesQuery(prevFilter), shopParams);
    console.log(`[Stats SQL] 현재기간 결과 rows: ${curRows.length}`, curRows.map(r => ({ region: r.region, valid_count: r.valid_count, total_sales: r.total_sales })));
    console.log(`[Stats SQL] 전월기간 결과 rows: ${prevRows.length}`, prevRows.map(r => ({ region: r.region, valid_count: r.valid_count, total_sales: r.total_sales })));

    // region별 맵 구성
    const toMap = (rows) => {
      const m = {};
      for (const r of rows) m[r.region] = r;
      return m;
    };
    const curMap  = toMap(curRows);
    const prevMap = toMap(prevRows);

    // 전체 합산 (KRW 환산)
    let totalKrw = 0, prevTotalKrw = 0;
    for (const r of curRows)  totalKrw     += parseFloat(r.total_sales || 0) * parseFloat(r.rate_to_krw || 1);
    for (const r of prevRows) prevTotalKrw += parseFloat(r.total_sales || 0) * parseFloat(r.rate_to_krw || 1);

    const growth = (cur, prev) => {
      if (!prev || prev === 0) return cur > 0 ? 100 : 0;
      return Math.round(((cur - prev) / prev) * 1000) / 10; // 소수점1자리
    };

    const shopFilter2 = `AND o.shop_id IN (SELECT shop_id FROM shops WHERE is_active = 1)${shop_id ? ' AND o.shop_id = ?' : ''}`;

    // 샵별 집계 (현재 기간) - UNPAID/PENDING/CANCELLED 제외, merchandise_subtotal 기준
    const [byShop] = await db.query(
      `SELECT
        o.shop_id, o.region, s.alias,
        COUNT(*) as order_count,
        SUM(CASE WHEN o.order_status NOT IN ('UNPAID', 'PENDING', 'CANCELLED') THEN
          COALESCE(o.escrow_amount, 0) ELSE 0 END) as total_escrow,
        SUM(CASE WHEN o.order_status NOT IN ('UNPAID', 'PENDING', 'CANCELLED') THEN
          COALESCE(o.merchandise_subtotal, 0) ELSE 0 END) as total_merchandise,
        o.currency,
        r.rate_to_krw
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       LEFT JOIN exchange_rates r ON o.currency = r.currency
       WHERE 1=1 ${shopFilter2} ${curFilter}
       GROUP BY o.shop_id, o.region, s.alias, o.currency, r.rate_to_krw`,
      shopParams
    );

    // 주문 상태별 집계 (현재 기간)
    const [byStatus] = await db.query(
      `SELECT
        o.order_status,
        COUNT(*) as count
       FROM orders o
       WHERE 1=1 ${shopFilter} ${curFilter}
       GROUP BY o.order_status
       ORDER BY count DESC`,
      shopParams
    );

    // ── 월매출 고정 쿼리 (당월 1일~오늘, 날짜 필터와 무관) ────────────
    const monthlyFrom = `${kstYear}-${String(kstMonth).padStart(2,'0')}-01`;
    const monthlyTo   = defaultTo; // 오늘 (kstDay 기준)
    const monthlyPrevFrom = shiftToPrevMonth(monthlyFrom);
    const monthlyPrevTo   = shiftToPrevMonth(monthlyTo);
    const monthlyFilter     = buildDateFilter(monthlyFrom, monthlyTo);
    const monthlyPrevFilter = buildDateFilter(monthlyPrevFrom, monthlyPrevTo);

    console.log(`[Stats] 월매출 기간: ${monthlyFrom}~${monthlyTo} | 전월: ${monthlyPrevFrom}~${monthlyPrevTo}`);

    const [monthlyRows]     = await db.query(salesQuery(monthlyFilter),     shopParams);
    const [monthlyPrevRows] = await db.query(salesQuery(monthlyPrevFilter), shopParams);

    let monthlyKrw = 0, monthlyPrevKrw = 0;
    for (const r of monthlyRows)     monthlyKrw     += parseFloat(r.total_sales || 0) * parseFloat(r.rate_to_krw || 1);
    for (const r of monthlyPrevRows) monthlyPrevKrw += parseFloat(r.total_sales || 0) * parseFloat(r.rate_to_krw || 1);
    const monthlyKrwRounded     = Math.round(monthlyKrw);
    const monthlyPrevKrwRounded = Math.round(monthlyPrevKrw);

    // ── 응답 구성 ──────────────────────────────────────────────────
    // 지역별 카드 데이터 (SG/MY/PH/TW)
    const regions = ['SG', 'MY', 'PH', 'TW'];
    const regionCards = regions.map(region => {
      const cur  = curMap[region]  || {};
      const prev = prevMap[region] || {};
      const curSales  = parseFloat(cur.total_sales  || 0);
      const prevSales = parseFloat(prev.total_sales || 0);
      return {
        region,
        currency: cur.currency || { SG:'SGD', MY:'MYR', PH:'PHP', TW:'TWD' }[region],
        rate_to_krw: parseFloat(cur.rate_to_krw || 0),
        order_count:  parseInt(cur.valid_count  || 0),
        total_sales:  curSales,
        prev_sales:   prevSales,
        growth_pct:   growth(curSales, prevSales),
        total_escrow: parseFloat(cur.total_escrow || 0),
      };
    });

    const curTotalKrw  = Math.round(totalKrw);
    const prevTotalKrwRounded = Math.round(prevTotalKrw);

    // 전체 지역 합산 주문 건수 (valid_count 기준, UNPAID/PENDING/CANCELLED 제외)
    const totalOrderCount = curRows.reduce((sum, r) => sum + parseInt(r.valid_count || 0), 0);

    return res.json({
      success: true,
      date_range: { from: rangeFrom, to: rangeTo },
      prev_date_range: { from: prevFrom, to: prevTo },
      region_cards: regionCards,
      total_krw: curTotalKrw,
      prev_total_krw: prevTotalKrwRounded,
      total_krw_growth: growth(curTotalKrw, prevTotalKrwRounded),
      total_order_count: totalOrderCount,
      by_shop: byShop,
      by_status: byStatus,
      // 월매출 고정 (당월 1일~오늘, 날짜 필터 무관)
      monthly_krw: monthlyKrwRounded,
      monthly_prev_krw: monthlyPrevKrwRounded,
      monthly_krw_growth: growth(monthlyKrwRounded, monthlyPrevKrwRounded),
      monthly_date_range: { from: monthlyFrom, to: monthlyTo },
      monthly_prev_date_range: { from: monthlyPrevFrom, to: monthlyPrevTo },
    });
  } catch (err) {
    console.error('[OrdersRoute] stats error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/:orderSn
 * 주문 상세 (order_items 포함)
 */
router.get('/:orderSn', async (req, res) => {
  const { orderSn } = req.params;

  try {
    // 주문 기본 정보
    const [orders] = await db.query(
      `SELECT o.*,
        s.alias as shop_alias,
        r.rate_to_krw as krw_rate
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.shop_id
       LEFT JOIN exchange_rates r ON o.currency = r.currency
       WHERE o.order_sn = ?
       LIMIT 1`,
      [orderSn]
    );

    if (!orders.length) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // order_items
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_sn = ? ORDER BY id ASC`,
      [orderSn]
    );

    return res.json({
      success: true,
      data: {
        ...orders[0],
        item_list: items,
      },
    });
  } catch (err) {
    console.error('[OrdersRoute] detail error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
