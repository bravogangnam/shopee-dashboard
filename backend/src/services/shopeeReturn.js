const db = require('../config/database');
const { buildUrl } = require('../utils/shopeeSignature');
const {
  callWithRetry,
  shopeeAxios,
  sleep,
} = require('../utils/apiWrapper');
const { refreshShopToken } = require('./shopeeAuth');

const RETURN_LIST_PATH = '/api/v2/returns/get_return_list';
const RETURN_DETAIL_PATH = '/api/v2/returns/get_return_detail';

function makeAuthErrorHandler(shopId) {
  return async () => {
    console.log(
      `[ShopeeReturn] Auth/403 detected (shop_id=${shopId}), refreshing token...`
    );

    const ok = await refreshShopToken(shopId);

    if (!ok) {
      console.error(
        `[ShopeeReturn] refreshShopToken(${shopId}) failed — re-auth required`
      );
    }
  };
}

function makeRebuildGetRequest(path, params, shopId) {
  return async newAccessToken => {
    const newUrl = buildUrl(
      path,
      params,
      'shop',
      newAccessToken,
      shopId
    );

    return () => shopeeAxios.get(newUrl);
  };
}

function nullableString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text || null;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableBoolean(value) {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (error) {
    return JSON.stringify({
      serialization_error: error.message,
    });
  }
}

/**
 * Return/Refund 목록을 페이지 끝까지 조회한다.
 *
 * timeField:
 * - create_time: 과거 전체 백필
 * - update_time: 일반 증분 동기화
 */
async function getReturnList(
  shopId,
  timeFrom,
  timeTo,
  accessToken,
  { timeField = 'update_time' } = {}
) {
  if (!['create_time', 'update_time'].includes(timeField)) {
    throw new Error(`Unsupported return time field: ${timeField}`);
  }

  const allReturns = [];
  let pageNo = 1;

  while (true) {
    const params = {
      page_no: String(pageNo),
      page_size: '100',
    };

    if (timeField === 'create_time') {
      params.create_time_from = String(timeFrom);
      params.create_time_to = String(timeTo);
    } else {
      params.update_time_from = String(timeFrom);
      params.update_time_to = String(timeTo);
    }

    const url = buildUrl(
      RETURN_LIST_PATH,
      params,
      'shop',
      accessToken,
      shopId
    );

    const data = await callWithRetry(
      () => shopeeAxios.get(url),
      {
        context:
          `get_return_list[shop=${shopId}]` +
          `[field=${timeField}]` +
          `[page=${pageNo}]`,
        onAuthError: makeAuthErrorHandler(shopId),
        rebuildRequest: makeRebuildGetRequest(
          RETURN_LIST_PATH,
          params,
          shopId
        ),
      }
    );

    if (data.error && String(data.error).trim()) {
      throw new Error(
        `get_return_list error: ${data.error} - ${data.message || ''}`
      );
    }

    const response = data.response || {};
    const rows = Array.isArray(response.return)
      ? response.return
      : [];

    allReturns.push(...rows);

    console.log(
      `[ShopeeReturn] shop=${shopId}` +
      ` field=${timeField}` +
      ` page=${pageNo}` +
      ` rows=${rows.length}` +
      ` more=${Boolean(response.more)}`
    );

    if (!response.more) break;

    pageNo += 1;
    await sleep(500);

    if (pageNo > 1000) {
      throw new Error(
        `get_return_list pagination safety limit exceeded: shop=${shopId}`
      );
    }
  }

  return allReturns;
}

async function getReturnDetail(
  shopId,
  returnSn,
  accessToken
) {
  const params = {
    return_sn: String(returnSn),
  };

  const url = buildUrl(
    RETURN_DETAIL_PATH,
    params,
    'shop',
    accessToken,
    shopId
  );

  const data = await callWithRetry(
    () => shopeeAxios.get(url),
    {
      context:
        `get_return_detail[shop=${shopId}]` +
        `[return_sn=${returnSn}]`,
      onAuthError: makeAuthErrorHandler(shopId),
      rebuildRequest: makeRebuildGetRequest(
        RETURN_DETAIL_PATH,
        params,
        shopId
      ),
    }
  );

  if (data.error && String(data.error).trim()) {
    throw new Error(
      `get_return_detail error: ${data.error} - ${data.message || ''}`
    );
  }

  return data.response || null;
}

function normalizeReturnRow(
  raw,
  {
    tenantId,
    shopId,
  }
) {
  const negotiation = raw?.negotiation || {};
  const sellerProof = raw?.seller_proof || {};
  const sellerCompensation = raw?.seller_compensation || {};

  return {
    tenant_id: tenantId,
    shop_id: shopId,

    return_sn: nullableString(raw?.return_sn),
    order_sn: nullableString(raw?.order_sn),

    return_status: nullableString(raw?.status),
    return_reason: nullableString(raw?.reason),
    reassessed_request_reason:
      nullableString(raw?.reassessed_request_reason),
    text_reason: nullableString(raw?.text_reason),

    refund_amount: nullableNumber(raw?.refund_amount),
    currency: nullableString(raw?.currency),
    amount_before_discount:
      nullableNumber(raw?.amount_before_discount),

    create_time: nullableNumber(raw?.create_time),
    update_time: nullableNumber(raw?.update_time),
    due_date: nullableNumber(raw?.due_date),
    return_ship_due_date:
      nullableNumber(raw?.return_ship_due_date),
    return_seller_due_date:
      nullableNumber(raw?.return_seller_due_date),

    tracking_number:
      nullableString(raw?.tracking_number),
    needs_logistics:
      nullableBoolean(raw?.needs_logistics),

    buyer_username:
      nullableString(raw?.user?.username),

    negotiation_status:
      nullableString(
        raw?.negotiation_status ??
        negotiation?.negotiation_status
      ),

    seller_proof_status:
      nullableString(
        raw?.seller_proof_status ??
        sellerProof?.seller_proof_status
      ),

    seller_compensation_status:
      nullableString(
        raw?.seller_compensation_status ??
        sellerCompensation?.seller_compensation_status
      ),

    return_refund_type:
      nullableString(raw?.return_refund_type),

    return_solution:
      nullableNumber(raw?.return_solution),

    return_refund_request_type:
      nullableNumber(raw?.return_refund_request_type),

    validation_type:
      nullableString(raw?.validation_type),

    reverse_logistics_status:
      nullableString(
        raw?.reverse_logistics_status ??
        raw?.reverse_logistic_status ??
        raw?.logistics_status
      ),

    is_seller_arrange:
      nullableBoolean(raw?.is_seller_arrange),

    is_shipping_proof_mandatory:
      nullableBoolean(raw?.is_shipping_proof_mandatory),

    has_uploaded_shipping_proof:
      nullableBoolean(raw?.has_uploaded_shipping_proof),

    is_reverse_logistics_channel_integrated:
      nullableBoolean(
        raw?.is_reverse_logistics_channel_integrated
      ),

    reverse_logistics_channel_name:
      nullableString(
        raw?.reverse_logistics_channel_name ??
        raw?.reverse_logistic_channel_name
      ),

    raw_json: safeJson(raw),
  };
}

async function upsertReturnRefund(row) {
  if (!row.return_sn) {
    throw new Error('Return/Refund row has no return_sn');
  }

  if (!row.order_sn) {
    throw new Error(
      `Return/Refund ${row.return_sn} has no order_sn`
    );
  }

  await db.query(
    `INSERT INTO order_return_refunds (
       tenant_id,
       shop_id,
       return_sn,
       order_sn,

       return_status,
       return_reason,
       reassessed_request_reason,
       text_reason,

       refund_amount,
       currency,
       amount_before_discount,

       create_time,
       update_time,
       due_date,
       return_ship_due_date,
       return_seller_due_date,

       tracking_number,
       needs_logistics,
       buyer_username,

       negotiation_status,
       seller_proof_status,
       seller_compensation_status,

       return_refund_type,
       return_solution,
       return_refund_request_type,
       validation_type,
       reverse_logistics_status,

       is_seller_arrange,
       is_shipping_proof_mandatory,
       has_uploaded_shipping_proof,
       is_reverse_logistics_channel_integrated,
       reverse_logistics_channel_name,

       raw_json,
       synced_at
     ) VALUES (
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, NOW()
     )
     ON DUPLICATE KEY UPDATE
       order_sn = VALUES(order_sn),

       return_status = VALUES(return_status),
       return_reason = VALUES(return_reason),
       reassessed_request_reason =
         VALUES(reassessed_request_reason),
       text_reason = VALUES(text_reason),

       refund_amount = VALUES(refund_amount),
       currency = VALUES(currency),
       amount_before_discount =
         VALUES(amount_before_discount),

       create_time = VALUES(create_time),
       update_time = VALUES(update_time),
       due_date = VALUES(due_date),
       return_ship_due_date =
         VALUES(return_ship_due_date),
       return_seller_due_date =
         VALUES(return_seller_due_date),

       tracking_number = VALUES(tracking_number),
       needs_logistics = VALUES(needs_logistics),
       buyer_username = VALUES(buyer_username),

       negotiation_status =
         VALUES(negotiation_status),
       seller_proof_status =
         VALUES(seller_proof_status),
       seller_compensation_status =
         VALUES(seller_compensation_status),

       return_refund_type =
         VALUES(return_refund_type),
       return_solution = VALUES(return_solution),
       return_refund_request_type =
         VALUES(return_refund_request_type),
       validation_type = VALUES(validation_type),
       reverse_logistics_status =
         VALUES(reverse_logistics_status),

       is_seller_arrange =
         VALUES(is_seller_arrange),
       is_shipping_proof_mandatory =
         VALUES(is_shipping_proof_mandatory),
       has_uploaded_shipping_proof =
         VALUES(has_uploaded_shipping_proof),
       is_reverse_logistics_channel_integrated =
         VALUES(is_reverse_logistics_channel_integrated),
       reverse_logistics_channel_name =
         VALUES(reverse_logistics_channel_name),

       raw_json = VALUES(raw_json),
       synced_at = NOW()`,
    [
      row.tenant_id,
      row.shop_id,
      row.return_sn,
      row.order_sn,

      row.return_status,
      row.return_reason,
      row.reassessed_request_reason,
      row.text_reason,

      row.refund_amount,
      row.currency,
      row.amount_before_discount,

      row.create_time,
      row.update_time,
      row.due_date,
      row.return_ship_due_date,
      row.return_seller_due_date,

      row.tracking_number,
      row.needs_logistics,
      row.buyer_username,

      row.negotiation_status,
      row.seller_proof_status,
      row.seller_compensation_status,

      row.return_refund_type,
      row.return_solution,
      row.return_refund_request_type,
      row.validation_type,
      row.reverse_logistics_status,

      row.is_seller_arrange,
      row.is_shipping_proof_mandatory,
      row.has_uploaded_shipping_proof,
      row.is_reverse_logistics_channel_integrated,
      row.reverse_logistics_channel_name,

      row.raw_json,
    ]
  );

  /*
   * 실제 주문 상태(order_status)는 보존한다.
   * 화면 전용 display_status만 TO_RETURN으로 변경한다.
   */
  await db.query(
    `UPDATE orders
        SET display_status = 'TO_RETURN',
            display_status_reason = ?,
            display_status_checked_at = NOW(),
            synced_at = NOW()
      WHERE tenant_id = ?
        AND shop_id = ?
        AND order_sn = ?`,
    [
      `Return/Refund ${row.return_sn}: ${row.return_status || '-'}`,
      row.tenant_id,
      row.shop_id,
      row.order_sn,
    ]
  );
}

async function fetchReturnDetails(
  listRows,
  shopId,
  accessToken,
  {
    concurrency = 5,
  } = {}
) {
  const deduped = Array.from(
    new Map(
      listRows
        .filter(row => row?.return_sn)
        .map(row => [String(row.return_sn), row])
    ).values()
  );

  const results = [];

  for (
    let index = 0;
    index < deduped.length;
    index += concurrency
  ) {
    const chunk = deduped.slice(
      index,
      index + concurrency
    );

    const settled = await Promise.allSettled(
      chunk.map(async listRow => {
        try {
          const detail = await getReturnDetail(
            shopId,
            listRow.return_sn,
            accessToken
          );

          return detail || listRow;
        } catch (error) {
          console.warn(
            `[ShopeeReturn] detail fallback` +
            ` return_sn=${listRow.return_sn}` +
            ` error=${error.message}`
          );

          return listRow;
        }
      })
    );

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
      }
    }

    if (index + concurrency < deduped.length) {
      await sleep(300);
    }
  }

  return results;
}

async function syncReturnWindow({
  tenantId,
  shopId,
  accessToken,
  timeFrom,
  timeTo,
  timeField = 'update_time',
}) {
  const listRows = await getReturnList(
    shopId,
    timeFrom,
    timeTo,
    accessToken,
    { timeField }
  );

  if (!listRows.length) {
    return {
      listed: 0,
      synced: 0,
    };
  }

  const detailRows = await fetchReturnDetails(
    listRows,
    shopId,
    accessToken
  );

  let synced = 0;

  for (const raw of detailRows) {
    try {
      const row = normalizeReturnRow(
        raw,
        {
          tenantId,
          shopId,
        }
      );

      await upsertReturnRefund(row);
      synced += 1;
    } catch (error) {
      console.error(
        `[ShopeeReturn] upsert failed` +
        ` shop=${shopId}` +
        ` return_sn=${raw?.return_sn || '-'}` +
        ` error=${error.message}`
      );
    }
  }

  return {
    listed: listRows.length,
    synced,
  };
}

module.exports = {
  getReturnList,
  getReturnDetail,
  normalizeReturnRow,
  upsertReturnRefund,
  syncReturnWindow,
};
