/**
 * 주문 관련 API 라우트
 * GET /api/orders              - 주문 목록 (필터, 페이지네이션)
 * GET /api/orders/:orderSn     - 주문 상세 (items 포함)
 * GET /api/orders/stats        - 집계 통계 (대시보드용)
 * GET /api/orders/summary      - 간단 요약 (카드 표시용)
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const db = require('../config/database');
const { getCurrentTenantId } = require('../config/tenant');

router.use(requireAuth);
router.use(requireApprovedTenant);

const FIFO_COST_JOIN = `
  LEFT JOIN (
    SELECT
      m.tenant_id,
      m.order_sn,
      m.shop_id,
      SUM(a.total_cost) AS fifo_cost_price
    FROM inventory_movements m
    INNER JOIN inventory_allocations a
      ON a.tenant_id = m.tenant_id
     AND a.movement_id = m.id
    WHERE m.movement_type = 'SALE'
    GROUP BY m.tenant_id, m.order_sn, m.shop_id
  ) fifo
    ON fifo.tenant_id = o.tenant_id
   AND fifo.order_sn = o.order_sn
   AND fifo.shop_id = o.shop_id
`;

const FIFO_COST_SELECT = `
          fifo.fifo_cost_price,
          o.total_cost_price AS original_total_cost_price,
          o.total_vat AS original_total_vat,
          o.net_profit AS original_net_profit,
          o.product_profit AS original_product_profit,
          CASE
            WHEN fifo.fifo_cost_price IS NOT NULL THEN fifo.fifo_cost_price
            ELSE o.total_cost_price
          END AS total_cost_price,
          CASE
            WHEN fifo.fifo_cost_price IS NOT NULL THEN ROUND(fifo.fifo_cost_price * 0.1)
            ELSE o.total_vat
          END AS total_vat,
          CASE
            WHEN fifo.fifo_cost_price IS NOT NULL AND o.net_profit IS NOT NULL
              THEN o.net_profit - (fifo.fifo_cost_price - COALESCE(o.total_cost_price, 0))
            ELSE o.net_profit
          END AS net_profit,
          CASE
            WHEN fifo.fifo_cost_price IS NOT NULL AND o.product_profit IS NOT NULL
              THEN o.product_profit - (fifo.fifo_cost_price - COALESCE(o.total_cost_price, 0))
            ELSE o.product_profit
          END AS product_profit
  `;

const ORDER_SEARCH_STOP_WORDS = new Set([
  'and', 'or', 'of', 'the', 'a', 'an', 'in', 'on', 'for', 'to', 'with',
  '&', '-', '/', '+'
]);

function buildOrderSearchTerms(rawSearch) {
  const source = String(rawSearch || '').trim();
  if (!source) return [];

  return Array.from(
    new Set(
      source
        .split(/\s+/)
        .map(term => term.trim())
        .filter(Boolean)
        .map(term => term.toLowerCase().replace(/[^a-z0-9가-힣_]/g, ''))
        .filter(Boolean)
        .filter(term => !ORDER_SEARCH_STOP_WORDS.has(term))
        .filter(term => {
          if (/^[a-z]{1,2}$/i.test(term)) return false;
          return true;
        })
    )
  ).slice(0, 10);
}

function buildUnifiedOrderSearchClause(searchTerms, orderAlias = 'o') {
  if (!searchTerms.length) {
    return { clause: '', params: [] };
  }

  const termClauses = searchTerms.map(() => `
    (
      ${orderAlias}.order_sn COLLATE utf8mb4_unicode_ci LIKE ?
      OR EXISTS (
        SELECT 1
        FROM order_items oi
        WHERE oi.tenant_id = ${orderAlias}.tenant_id
          AND oi.order_sn COLLATE utf8mb4_unicode_ci = ${orderAlias}.order_sn COLLATE utf8mb4_unicode_ci
          AND (
            oi.item_sku COLLATE utf8mb4_unicode_ci LIKE ?
            OR oi.model_sku COLLATE utf8mb4_unicode_ci LIKE ?
            OR oi.item_name COLLATE utf8mb4_unicode_ci LIKE ?
            OR oi.model_name COLLATE utf8mb4_unicode_ci LIKE ?
          )
      )
    )
  `);

  const params = [];
  for (const term of searchTerms) {
    const likeTerm = `%${term}%`;
    params.push(
      likeTerm,
      likeTerm,
      likeTerm,
      likeTerm,
      likeTerm
    );
  }

  return {
    clause: ` AND (${termClauses.join(' AND ')})`,
    params,
  };
}

/**
 * GET /api/orders
 * Query params:
 *   page (default 1), page_size (default 20, max 100)
 *   shop_id, region, order_status
 *   date_from, date_to  (KST YYYY-MM-DD)
 *   order_sn/search  (통합 부분 검색: 주문번호/SKU/상품명)
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
    search: searchQuery,
    order_sn: orderSnSearch,
    include_open_backlog,
  } = req.query;

  const tenantId = getCurrentTenantId(req);

  const pageNum = Math.max(1, parseInt(page));
  const pageSize = Math.min(100, Math.max(1, parseInt(page_size)));
  const offset = (pageNum - 1) * pageSize;
  const search = String(searchQuery || orderSnSearch || '').trim();
  const searchTerms = buildOrderSearchTerms(search);

  // ── 요청 파라미터 로그 ────────────────────────────────────────
  console.log(`[Orders] REQ page=${pageNum} pageSize=${pageSize} offset=${offset} | filters: region=${region||'-'} status=${order_status||'-'} date=${date_from||'-'}~${date_to||'-'} search=${search||'-'}`);
  if (date_from || date_to) {
    console.log(`[Orders] DATE filter → WHERE order_created_at >= '${date_from||''}  00:00:00' AND <= '${date_to||''} 23:59:59' (KST 기준)`);
  }

  // 활성 샵 기반 필터
  let whereClause = `o.tenant_id = ? AND o.shop_id IN (SELECT shop_id FROM shops WHERE tenant_id = ? AND is_active = 1)`;
  const params = [tenantId, tenantId];
  const openBacklogStatuses = ['UNPAID', 'READY_TO_SHIP'];
  const includeOpenBacklog = ['1', 'true', 'yes'].includes(String(include_open_backlog || '').toLowerCase());
  let statusFilters = [];

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
    statusFilters = order_status.split(',').map(s => s.trim()).filter(Boolean);
    if (statusFilters.length === 1) {
      whereClause += ` AND o.order_status = ?`;
      params.push(statusFilters[0]);
    } else if (statusFilters.length > 1) {
      const placeholders = statusFilters.map(() => '?').join(',');
      whereClause += ` AND o.order_status IN (${placeholders})`;
      params.push(...statusFilters);
    }
  }

  const dateConditions = [];
  const dateParams = [];

  if (date_from) {
    // order_created_at은 KST 문자열로 저장 → KST 기준 필터
    dateConditions.push(`o.order_created_at >= ?`);
    dateParams.push(`${date_from} 00:00:00`);
  }

  if (date_to) {
    // order_created_at은 KST 문자열로 저장 → KST 기준 필터
    dateConditions.push(`o.order_created_at <= ?`);
    dateParams.push(`${date_to} 23:59:59`);
  }

  const shouldIncludeOpenBacklog = includeOpenBacklog &&
    dateConditions.length > 0 &&
    !search &&
    (
      statusFilters.length === 0 ||
      statusFilters.some(status => openBacklogStatuses.includes(status))
    );

  if (dateConditions.length) {
    if (shouldIncludeOpenBacklog) {
      const backlogPlaceholders = openBacklogStatuses.map(() => '?').join(',');
      whereClause += ` AND ((${dateConditions.join(' AND ')}) OR COALESCE(o.display_status, o.order_status) IN (${backlogPlaceholders}))`;
      params.push(...dateParams, ...openBacklogStatuses);
    } else {
      whereClause += ` AND ${dateConditions.join(' AND ')}`;
      params.push(...dateParams);
    }
  }

  if (searchTerms.length > 0) {
    const unifiedSearch = buildUnifiedOrderSearchClause(searchTerms, 'o');
    whereClause += unifiedSearch.clause;
    params.push(...unifiedSearch.params);
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
        o.id, o.shop_id, o.region, o.order_sn, o.order_status,
          o.display_status, o.display_status_reason, o.display_status_checked_at,
          o.is_final_status,
        COALESCE(o.merchandise_subtotal, o.total_amount) AS merchandise_subtotal, o.total_amount, o.currency,
        o.original_price, o.seller_discount, o.voucher_from_seller, o.voucher_from_shopee,
        o.coins_offset, o.buyer_total_amount,
        o.shipping_carrier, o.tracking_number, o.shipping_fee, o.shipping_fee_discount,
        o.actual_shipping_fee, o.estimated_shipping_fee, o.order_chargeable_weight_gram,
        o.commission_fee, o.service_fee, o.transaction_fee, o.escrow_amount,
        ${FIFO_COST_SELECT},
        o.margin_status,
          o.total_discounted_price,
        o.create_time, o.order_created_at, o.update_time, o.synced_at,
        s.alias as shop_alias,
        r.rate_to_krw as krw_rate
       FROM orders o
       ${FIFO_COST_JOIN}
       LEFT JOIN shops s ON s.tenant_id = o.tenant_id AND o.shop_id = s.shop_id
       LEFT JOIN exchange_rates r
         ON o.currency COLLATE utf8mb4_general_ci = r.currency
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
              image_info_image_url, item_image_url,
              cost_price_at_order, discounted_price_at_order, vat_at_order
       FROM order_items
       WHERE tenant_id = ?
         AND order_sn IN (${snPlaceholders})
       ORDER BY id ASC`,
      [tenantId, ...orderSnList]
    );

    const itemsByOrderSn = {};
    for (const item of items) {
      if (!itemsByOrderSn[item.order_sn]) itemsByOrderSn[item.order_sn] = [];
      itemsByOrderSn[item.order_sn].push(item);
    }

    const enrichedOrders = orders.map(o => {
      const its = itemsByOrderSn[o.order_sn] || [];
      return {
        ...o,
        merchandise_subtotal: o.merchandise_subtotal ?? null,
        net_profit: o.net_profit ?? null,
        product_profit: o.product_profit ?? null,
        margin_status: o.margin_status ?? 'pending',
        total_cost_price: o.total_cost_price ?? null,
        total_discounted_price: o.total_discounted_price ?? null,
        total_vat: o.total_vat ?? null,
        krw_rate: o.krw_rate ?? null,
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
  const tenantId = getCurrentTenantId(req);

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
  const shopFilter = `AND o.tenant_id = ? AND o.shop_id IN (SELECT shop_id FROM shops WHERE tenant_id = ? AND is_active = 1)${shop_id ? ' AND o.shop_id = ?' : ''}`;
  const shopParams = shop_id ? [tenantId, tenantId, shop_id] : [tenantId, tenantId];

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
        COALESCE(o.merchandise_subtotal, o.total_amount, 0) ELSE 0 END) as total_sales,
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

    const shopFilter2 = `AND o.tenant_id = ? AND o.shop_id IN (SELECT shop_id FROM shops WHERE tenant_id = ? AND is_active = 1)${shop_id ? ' AND o.shop_id = ?' : ''}`;

    // 샵별 집계 (현재 기간) - UNPAID/PENDING/CANCELLED 제외, merchandise_subtotal 기준
    const [byShop] = await db.query(
      `SELECT
        o.shop_id, o.region, s.alias,
        COUNT(*) as order_count,
        SUM(CASE WHEN o.order_status NOT IN ('UNPAID', 'PENDING', 'CANCELLED') THEN
          COALESCE(o.escrow_amount, 0) ELSE 0 END) as total_escrow,
        SUM(CASE WHEN o.order_status NOT IN ('UNPAID', 'PENDING', 'CANCELLED') THEN
          COALESCE(o.merchandise_subtotal, o.total_amount, 0) ELSE 0 END) as total_merchandise,
        o.currency,
        r.rate_to_krw
       FROM orders o
       LEFT JOIN shops s ON s.tenant_id = o.tenant_id AND o.shop_id = s.shop_id
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
/**
 * GET /api/orders/summary
 * Settlement list summary.
 */
router.get('/summary', async (req, res) => {
  const { date_from, date_to, region, order_status, order_sn, search: searchQuery } = req.query;
  const dateFrom = date_from || null;
  const dateTo = date_to || null;
  const regionFilter = region || null;
  const statusFilter = order_status || null;
  const search = String(searchQuery || order_sn || '').trim();
  const searchTerms = buildOrderSearchTerms(search);
  const tenantId = getCurrentTenantId(req);

  try {
    const summarySql = `SELECT
        COALESCE(SUM(COALESCE(o.merchandise_subtotal, o.total_amount) * er.rate_to_krw), 0) AS total_sales_krw,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(o.order_chargeable_weight_gram, 0) > 0
              THEN o.escrow_amount * er.rate_to_krw
            ELSE 0
          END
        ), 0) AS total_escrow_krw,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(o.order_chargeable_weight_gram, 0) <= 0 THEN 0
            WHEN fifo.fifo_cost_price IS NOT NULL AND o.net_profit IS NOT NULL
              THEN o.net_profit - (fifo.fifo_cost_price - COALESCE(o.total_cost_price, 0))
            ELSE o.net_profit
          END
        ), 0) AS total_net_profit,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(o.order_chargeable_weight_gram, 0) > 0
              THEN COALESCE(o.merchandise_subtotal, o.total_amount) * er.rate_to_krw
            ELSE 0
          END
        ), 0) AS confirmed_sales_krw,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(o.order_chargeable_weight_gram, 0) <= 0 THEN 0
            WHEN fifo.fifo_cost_price IS NOT NULL AND o.product_profit IS NOT NULL
              THEN o.product_profit - (fifo.fifo_cost_price - COALESCE(o.total_cost_price, 0))
            ELSE o.product_profit
          END
        ), 0) AS total_product_profit,
        COALESCE(SUM(
            CASE
              WHEN fifo.fifo_cost_price IS NOT NULL THEN ROUND(fifo.fifo_cost_price * 0.1)
              ELSE o.total_vat
            END
          ), 0) AS total_vat,
        COUNT(*) AS order_count
       FROM orders o
       ${FIFO_COST_JOIN}
       LEFT JOIN exchange_rates er
         ON o.currency COLLATE utf8mb4_general_ci = er.currency
       WHERE o.tenant_id = ?
          AND o.order_status NOT IN ('UNPAID', 'PENDING', 'CANCELLED')
         AND (? IS NULL OR o.order_created_at >= ?)
         AND (? IS NULL OR o.order_created_at < DATE_ADD(?, INTERVAL 1 DAY))
         AND (? IS NULL OR o.region = ?)
         AND (? IS NULL OR o.order_status = ?)`;

    const buildSummaryParams = (from, to) => [
        tenantId,
        from, from,
      to, to,
      regionFilter, regionFilter,
      statusFilter, statusFilter,
    ];

    const round2 = value => Math.round(Number(value || 0) * 100) / 100;
    const parseSummary = row => ({
      total_sales_krw: round2(row?.total_sales_krw),
      total_escrow_krw: round2(row?.total_escrow_krw),
      total_net_profit: round2(row?.total_net_profit),
      confirmed_sales_krw: round2(row?.confirmed_sales_krw),
      total_product_profit: round2(row?.total_product_profit),
      total_vat: round2(row?.total_vat),
      order_count: parseInt(row?.order_count || 0),
    });
    const changeRate = (current, previous) => {
      if (previous === null || previous === undefined || Number(previous) === 0) return null;
      return Math.round(((Number(current) - Number(previous)) / Number(previous)) * 10000) / 100;
    };

    const currentParams = buildSummaryParams(dateFrom, dateTo);
    const currentSearchSql = buildUnifiedOrderSearchClause(searchTerms, 'o');
    const [rows] = await db.query(
      `${summarySql}${currentSearchSql.clause}`,
      [...currentParams, ...currentSearchSql.params]
    );

    const currentSummary = parseSummary(rows[0] || {});
    const profitRate = currentSummary.confirmed_sales_krw === 0
      ? 0
      : Math.round((currentSummary.total_net_profit / currentSummary.confirmed_sales_krw) * 10000) / 100;
    const productProfitRate = currentSummary.confirmed_sales_krw === 0
      ? 0
      : Math.round((currentSummary.total_product_profit / currentSummary.confirmed_sales_krw) * 10000) / 100;
    const prevProductProfitRate = prevSummary.confirmed_sales_krw === 0 || prevSummary.confirmed_sales_krw === null
      ? null
      : Math.round((prevSummary.total_product_profit / prevSummary.confirmed_sales_krw) * 10000) / 100;

    let prevSummary = {
      total_sales_krw: null,
      total_escrow_krw: null,
      total_net_profit: null,
      confirmed_sales_krw: null,
      total_product_profit: null,
      total_vat: null,
      order_count: null,
    };

      if (dateFrom && dateTo) {
        const parseYmd = value => {
          const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (!match) return null;
          return {
            year: Number(match[1]),
            month: Number(match[2]),
            day: Number(match[3]),
          };
        };

        const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

        const shiftToPreviousMonthSameDay = value => {
          const parsed = parseYmd(value);
          if (!parsed) return null;

          const prevMonth = parsed.month === 1 ? 12 : parsed.month - 1;
          const prevYear = parsed.month === 1 ? parsed.year - 1 : parsed.year;
          const prevDay = Math.min(parsed.day, daysInMonth(prevYear, prevMonth));

          return `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(prevDay).padStart(2, '0')}`;
        };

        const prevDateFrom = shiftToPreviousMonthSameDay(dateFrom);
        const prevDateTo = shiftToPreviousMonthSameDay(dateTo);

        if (prevDateFrom && prevDateTo) {
          const prevParams = buildSummaryParams(prevDateFrom, prevDateTo);
          const prevSearchSql = buildUnifiedOrderSearchClause(searchTerms, 'o');
          const [prevRows] = await db.query(
            `${summarySql}${prevSearchSql.clause}`,
            [...prevParams, ...prevSearchSql.params]
          );
          prevSummary = parseSummary(prevRows[0] || {});
        }
      }

    return res.json({
      success: true,
      summary: {
        total_sales_krw: currentSummary.total_sales_krw,
        total_escrow_krw: currentSummary.total_escrow_krw,
        total_net_profit: currentSummary.total_net_profit,
        confirmed_sales_krw: currentSummary.confirmed_sales_krw,
        total_product_profit: currentSummary.total_product_profit,
        total_vat: currentSummary.total_vat,
        profit_rate: profitRate,
        product_profit_rate: productProfitRate,
        order_count: currentSummary.order_count,

        prev_total_sales_krw: prevSummary.total_sales_krw,
        prev_total_escrow_krw: prevSummary.total_escrow_krw,
        prev_total_net_profit: prevSummary.total_net_profit,
        prev_confirmed_sales_krw: prevSummary.confirmed_sales_krw,
        prev_total_product_profit: prevSummary.total_product_profit,
        prev_total_vat: prevSummary.total_vat,
        prev_order_count: prevSummary.order_count,

        sales_change_rate: changeRate(currentSummary.total_sales_krw, prevSummary.total_sales_krw),
        escrow_change_rate: changeRate(currentSummary.total_escrow_krw, prevSummary.total_escrow_krw),
        profit_change_rate: changeRate(currentSummary.total_net_profit, prevSummary.total_net_profit),
        product_profit_rate_change_rate: changeRate(productProfitRate, prevProductProfitRate),
        vat_change_rate: changeRate(currentSummary.total_vat, prevSummary.total_vat),
        count_change_rate: changeRate(currentSummary.order_count, prevSummary.order_count),
      },
    });
  } catch (err) {
    console.error('[OrdersRoute] summary error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/daily-sales
 * Daily KRW sales for a month, based on stored orders only.
 */
router.get('/daily-sales', async (req, res) => {
  const monthParam = typeof req.query.month === 'string' ? req.query.month : '';
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : defaultMonth;
  const [year, monthNumber] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const tenantId = getCurrentTenantId(req);

  try {
    const [rows] = await db.query(
      `SELECT
         DATE(o.order_created_at) AS sales_date,
         DAY(o.order_created_at) AS day,
         COALESCE(SUM(COALESCE(o.merchandise_subtotal, o.total_amount) * er.rate_to_krw), 0) AS sales_krw,
         COUNT(*) AS order_count
       FROM orders o
       LEFT JOIN exchange_rates er
         ON o.currency COLLATE utf8mb4_general_ci = er.currency
       WHERE o.tenant_id = ?
          AND o.order_status NOT IN ('UNPAID', 'PENDING', 'CANCELLED')
          AND o.order_created_at >= ?
         AND o.order_created_at < DATE_ADD(?, INTERVAL 1 MONTH)
       GROUP BY DATE(o.order_created_at), DAY(o.order_created_at)
       ORDER BY sales_date ASC`,
      [tenantId, monthStart, monthStart]
    );

    const rowMap = new Map(
      rows.map(row => [
        Number(row.day),
        {
          sales_krw: Math.round(Number(row.sales_krw || 0) * 100) / 100,
          order_count: parseInt(row.order_count || 0),
        },
      ])
    );

    const data = Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const date = `${month}-${String(day).padStart(2, '0')}`;
      const row = rowMap.get(day);
      return {
        date,
        day,
        sales_krw: row?.sales_krw || 0,
        order_count: row?.order_count || 0,
      };
    });

    return res.json({ success: true, month, data });
  } catch (err) {
    console.error('[OrdersRoute] daily-sales error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:orderSn', async (req, res) => {
  const { orderSn } = req.params;
  const tenantId = getCurrentTenantId(req);

  try {
    // 주문 기본 정보
    const [orders] = await db.query(
      `SELECT
        o.*,
        ${FIFO_COST_SELECT},
        s.alias as shop_alias,
        r.rate_to_krw as krw_rate
       FROM orders o
       ${FIFO_COST_JOIN}
       LEFT JOIN shops s ON s.tenant_id = o.tenant_id AND o.shop_id = s.shop_id
       LEFT JOIN exchange_rates r ON o.currency = r.currency
       WHERE o.tenant_id = ?
          AND o.order_sn = ?
         LIMIT 1`,
       [tenantId, orderSn]
    );

    if (!orders.length) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // order_items
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE tenant_id = ? AND order_sn = ? ORDER BY id ASC`,
       [tenantId, orderSn]
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
