/**
 * Shopee Logistics API 서비스
 *
 * API 호출 순서 (READY_TO_SHIP):
 *   1. get_shipping_parameter → pickup/dropoff/non_integrated 판별
 *   2. ship_order             → PROCESSED 상태로 전환
 *   3. get_tracking_number    → tracking_number 획득
 *   4. get_shipping_document_parameter → 지원 document type 확인
 *   5. create_shipping_document → 비동기 생성 태스크 시작
 *   6. get_shipping_document_result  → READY 될 때까지 폴링
 *   7. download_shipping_document    → PDF 바이너리 수신
 *
 * API 호출 순서 (PROCESSED):
 *   1. [캐시 확인] → 캐시 히트 시 즉시 반환
 *   2. get_tracking_number    → 최신 tracking_number 확보
 *   3. get_shipping_document_parameter → 지원 document type 확인
 *   4. create_shipping_document → 비동기 생성 태스크 시작
 *   5. get_shipping_document_result  → READY 될 때까지 폴링
 *   6. download_shipping_document    → PDF 바이너리 수신
 *
 * 인증: shop별 access_token (getOrRefreshShopToken) + shop_id 파라미터 전달
 * 주의: TW 일부 채널은 HTML 반환 → PDF 변환 필요
 */

const { buildUrl } = require('../utils/shopeeSignature');
const { callWithRetry, shopeeAxios, sleep } = require('../utils/apiWrapper');
const { refreshShopToken, getOrRefreshShopToken } = require('./shopeeAuth');

// ─── 공통 헬퍼: already-shipped 에러 판별 ──────────────────────────
/**
 * Shopee가 "Package not eligible for rescheduling" 에러를 반환하는 경우는
 * 해당 주문이 이미 PROCESSED 상태인 경우임.
 *
 * 에러 발생 위치:
 *   - get_shipping_parameter: Business error (apiWrapper가 throw)
 *   - ship_order: data.error 체크 후 throw
 * 두 경우 모두 에러 메시지에 "not eligible for rescheduling"이 포함됨.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isAlreadyShippedError(err) {
  const msg = err?.message || '';
  return (
    msg.includes('not eligible for rescheduling') ||
    (err?.shopeeError === 'error_other' && msg.includes('not eligible'))
  );
}

// ─── 인증 헬퍼 ───────────────────────────────────────────────────
// shop별 onAuthError 핸들러 — 403 발생 시 해당 shop 토큰만 갱신
function makeAuthErrorHandler(shopId) {
  return async () => {
    console.log(`[Logistics] Auth/403 detected (shop_id=${shopId}), refreshing shop token...`);
    const ok = await refreshShopToken(shopId);
    if (!ok) {
      console.error(`[Logistics] refreshShopToken(${shopId}) failed — Re-auth required.`);
    }
  };
}

/**
 * URL 재서명 팩토리 (rebuildRequest용)
 * 토큰 갱신 후 새 access_token으로 URL+sign을 재생성해 requestFn을 교체한다.
 */
function makeRebuildRequest(method, path, params, urlType, id, body = null) {
  return async (newAccessToken) => {
    const newUrl = buildUrl(path, params, urlType, newAccessToken, id);
    if (method === 'post') {
      const postBody = body;
      return () => shopeeAxios.post(newUrl, postBody);
    }
    return () => shopeeAxios.get(newUrl);
  };
}

// ─── 1. get_shipping_parameter ───────────────────────────────────
/**
 * 주문의 배송 방식(pickup/dropoff/non_integrated) 및 필요 파라미터 조회
 * @param {number} shopId
 * @param {string} orderSn
 * @param {string} accessToken
 * @returns {object} response (info_needed, pickup, dropoff 등)
 */
async function getShippingParameter(shopId, orderSn, accessToken) {
  const path   = '/api/v2/logistics/get_shipping_parameter';
  const params = { order_sn: orderSn };
  const url    = buildUrl(path, params, 'shop', accessToken, shopId);

  const data = await callWithRetry(
    () => shopeeAxios.get(url),
    {
      context: `get_shipping_parameter[shop=${shopId}][${orderSn}]`,
      onAuthError: makeAuthErrorHandler(shopId),
      rebuildRequest: makeRebuildRequest('get', path, params, 'shop', shopId),
    }
  );

  if (data.error && data.error !== '') {
    throw new Error(`get_shipping_parameter error: ${data.error} - ${data.message}`);
  }

  return data.response || {};
}

// ─── 2. ship_order ───────────────────────────────────────────────
/**
 * 배송 처리 (READY_TO_SHIP → PROCESSED)
 * @param {number} shopId
 * @param {string} orderSn
 * @param {object} shippingParam - get_shipping_parameter 응답
 * @param {string} accessToken
 * @returns {object} response
 */
async function shipOrder(shopId, orderSn, shippingParam, accessToken) {
  const path = '/api/v2/logistics/ship_order';
  const url  = buildUrl(path, {}, 'shop', accessToken, shopId);

  const infoNeeded = shippingParam.info_needed || {};
  const body = { order_sn: orderSn };

  // 배송 방식 판별: pickup > dropoff > non_integrated 순서
  if (infoNeeded.pickup && infoNeeded.pickup.length > 0) {
    // pickup 방식
    const pickupInfo = shippingParam.pickup || {};
    const addressList = pickupInfo.address_list || [];
    const pickupTimeList = pickupInfo.pickup_time_id_list || [];

    // 첫 번째 주소 + 첫 번째 시간대 선택
    const address = addressList[0];
    const pickupTimeId = pickupTimeList[0]?.pickup_time_id || pickupTimeList[0];

    body.pickup = {
      address_id: address?.address_id,
      pickup_time_id: pickupTimeId,
    };
    console.log(`[Logistics] ship_order[${orderSn}] pickup: address_id=${address?.address_id}, time_id=${pickupTimeId}`);

  } else if (infoNeeded.dropoff && infoNeeded.dropoff.length > 0) {
    // dropoff 방식
    body.dropoff = {};
    // slug가 있으면 포함 (TW 필수)
    if (shippingParam.dropoff?.slug) {
      body.dropoff.slug = shippingParam.dropoff.slug;
    }
    console.log(`[Logistics] ship_order[${orderSn}] dropoff`);

  } else if (infoNeeded.non_integrated && infoNeeded.non_integrated.length > 0) {
    // non_integrated: tracking_number 필수
    // 이미 tracking_number 있으면 사용, 없으면 임시값
    body.non_integrated = {};
    console.log(`[Logistics] ship_order[${orderSn}] non_integrated`);
  } else {
    // info_needed가 모두 비어있는 경우 → dropoff 시도
    body.dropoff = {};
    console.log(`[Logistics] ship_order[${orderSn}] default dropoff (info_needed empty)`);
  }

  const data = await callWithRetry(
    () => shopeeAxios.post(url, body),
    {
      context: `ship_order[shop=${shopId}][${orderSn}]`,
      onAuthError: makeAuthErrorHandler(shopId),
      rebuildRequest: makeRebuildRequest('post', path, {}, 'shop', shopId, body),
    }
  );

  if (data.error && data.error !== '') {
    const errCode = data.error;
    const errMsg  = data.message || '';

    // "Package not eligible for rescheduling" → 이미 배송 처리 완료된 상태
    // isAlreadyShippedError() 공통 헬퍼로 판별 (get_shipping_parameter와 동일 처리)
    if (errCode === 'error_other' && /not eligible for rescheduling/i.test(errMsg)) {
      console.warn(`[Logistics] ship_order[${orderSn}] already shipped: ${errMsg}`);
      const err = new Error(`ship_order: already shipped — ${errMsg}`);
      err.alreadyShipped = true;
      throw err;
    }

    throw new Error(`ship_order error: ${errCode} - ${errMsg}`);
  }

  return data.response || {};
}

// ─── 3. get_tracking_number ──────────────────────────────────────
/**
 * 트래킹 번호 조회
 * @param {number} shopId
 * @param {string} orderSn
 * @param {string} accessToken
 * @returns {string|null} tracking_number
 */
async function getTrackingNumber(shopId, orderSn, accessToken) {
  const path   = '/api/v2/logistics/get_tracking_number';
  const params = { order_sn: orderSn };
  const url    = buildUrl(path, params, 'shop', accessToken, shopId);

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

  return data.response?.tracking_number || null;
}

// ─── 4. get_shipping_document_parameter ─────────────────────────
/**
 * 지원되는 shipping document 타입 조회 (POST 방식)
 * @param {number} shopId
 * @param {string[]} orderSnList
 * @param {string} accessToken
 * @returns {object[]} order별 지원 타입 목록
 */
async function getShippingDocumentParameter(shopId, orderSnList, accessToken) {
  const path = '/api/v2/logistics/get_shipping_document_parameter';
  const url  = buildUrl(path, {}, 'shop', accessToken, shopId);
  const body = { order_list: orderSnList.map(sn => ({ order_sn: sn })) };

  const data = await callWithRetry(
    () => shopeeAxios.post(url, body),
    {
      context: `get_shipping_document_parameter[shop=${shopId}]`,
      onAuthError: makeAuthErrorHandler(shopId),
      rebuildRequest: makeRebuildRequest('post', path, {}, 'shop', shopId, body),
    }
  );

  if (data.error && data.error !== '') {
    throw new Error(`get_shipping_document_parameter error: ${data.error} - ${data.message}`);
  }

  // 전체 응답 로깅 (필드명 확인용)
  console.log(`[Logistics] get_shipping_document_parameter response:`, JSON.stringify(data.response));

  return data.response?.result_list || [];
}

// ─── 5. create_shipping_document ─────────────────────────────────
/**
 * 송장 생성 태스크 시작
 * @param {number} shopId
 * @param {Array<{order_sn, shipping_document_type}>} orderList
 * @param {string} accessToken
 * @returns {object[]} result_list
 */
async function createShippingDocument(shopId, orderList, accessToken) {
  const path = '/api/v2/logistics/create_shipping_document';
  const url  = buildUrl(path, {}, 'shop', accessToken, shopId);
  const body = { order_list: orderList };

  console.log(`[Logistics] create_shipping_document REQUEST body:`, JSON.stringify(body));

  const data = await callWithRetry(
    () => shopeeAxios.post(url, body),
    {
      context: `create_shipping_document[shop=${shopId}]`,
      onAuthError: makeAuthErrorHandler(shopId),
      rebuildRequest: makeRebuildRequest('post', path, {}, 'shop', shopId, body),
    }
  );

  // 전체 응답 로깅 (error, message, result_list.fail_error 모두 포함)
  console.log(`[Logistics] create_shipping_document FULL RESPONSE:`, JSON.stringify(data));

  if (data.error && data.error !== '') {
    // batch_api_all_failed 등 — result_list 세부 내용도 함께 출력
    const resultList = data.response?.result_list || [];
    console.error(`[Logistics] create_shipping_document FAILED result_list:`, JSON.stringify(resultList));
    throw new Error(`create_shipping_document error: ${data.error} - ${data.message}`);
  }

  return data.response?.result_list || [];
}

// ─── 6. get_shipping_document_result (폴링) ──────────────────────
/**
 * 송장 생성 결과 폴링 (최대 maxAttempts회, interval ms 간격)
 *
 * 공식 스펙: POST /api/v2/logistics/get_shipping_document_result
 *   body: { order_list: [{ order_sn, package_number? }] }
 *   (GET + query param order_sn_list 방식은 404 발생 — 잘못된 방식)
 *
 * @param {number} shopId
 * @param {string[]} orderSnList
 * @param {string} accessToken
 * @param {number} maxAttempts
 * @param {number} interval ms
 * @returns {object[]} READY 상태 항목들
 */
async function pollShippingDocumentResult(
  shopId, orderSnList, accessToken,
  maxAttempts = 30, interval = 2000
) {
  const path = '/api/v2/logistics/get_shipping_document_result';
  // ⚠️ 공식 스펙: POST + JSON body (GET + query param 방식은 404)
  const body = { order_list: orderSnList.map(sn => ({ order_sn: sn })) };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(attempt === 1 ? 1000 : interval);

    // URL은 쿼리 파라미터 없이 빌드 (서명/인증 파라미터만 포함)
    const url = buildUrl(path, {}, 'shop', accessToken, shopId);

    const data = await callWithRetry(
      () => shopeeAxios.post(url, body),
      {
        context: `get_shipping_document_result[shop=${shopId}][attempt=${attempt}]`,
        onAuthError: makeAuthErrorHandler(shopId),
        rebuildRequest: makeRebuildRequest('post', path, {}, 'shop', shopId, body),
      }
    );

    if (data.error && data.error !== '') {
      throw new Error(`get_shipping_document_result error: ${data.error} - ${data.message}`);
    }

    const resultList = data.response?.result_list || [];
    const allReady   = resultList.every(r => r.status === 'READY' || (r.fail_error && r.fail_error !== ''));

    console.log(`[Logistics] poll attempt ${attempt}/${maxAttempts}: ${JSON.stringify(resultList.map(r => ({ sn: r.order_sn, status: r.status, fail: r.fail_error || '' })))}`);

    if (allReady && resultList.length > 0) {
      return resultList;
    }
  }

  throw new Error(`Shipping document not ready after ${maxAttempts} attempts`);
}

// ─── 7. download_shipping_document ───────────────────────────────
/**
 * 송장 PDF 다운로드 (binary)
 *
 * 공식 스펙 (download_shipping_document):
 *   shipping_document_type → 요청 최상위 레벨 (order_list 바깥)
 *   order_list[]           → { order_sn, package_number? }
 *
 *   응답: waybill 파일 (binary 직접 반환)
 *         에러 시 JSON {error, message, request_id} 반환
 *
 * @param {number} shopId
 * @param {string} orderSn
 * @param {string} shippingDocumentType  e.g. 'THERMAL_AIR_WAYBILL'
 * @param {string} accessToken
 * @returns {Buffer} PDF 바이너리
 */
async function downloadShippingDocument(shopId, orderSn, shippingDocumentType, accessToken) {
  const path = '/api/v2/logistics/download_shipping_document';
  const url  = buildUrl(path, {}, 'shop', accessToken, shopId);

  // ⚠️ 핵심: shipping_document_type은 order_list 외부 최상위 레벨
  //   (order_list 내부에 넣으면 API 에러 발생)
  const body = {
    shipping_document_type: shippingDocumentType,
    order_list: [{ order_sn: orderSn }],
  };

  console.log(`[Logistics] download_shipping_document REQUEST:`, JSON.stringify(body));

  // arraybuffer로 받음 — apiWrapper의 arraybuffer 분기가 JSON 체크를 건너뜀
  const rawData = await callWithRetry(
    () => shopeeAxios.post(url, body, { responseType: 'arraybuffer' }),
    {
      context: `download_shipping_document[shop=${shopId}][${orderSn}]`,
      onAuthError: makeAuthErrorHandler(shopId),
      rebuildRequest: async (newToken) => {
        const newUrl = buildUrl(path, {}, 'shop', newToken, shopId);
        return () => shopeeAxios.post(newUrl, body, { responseType: 'arraybuffer' });
      },
    }
  );

  let buffer;
  if (Buffer.isBuffer(rawData)) {
    buffer = rawData;
  } else if (rawData instanceof ArrayBuffer) {
    buffer = Buffer.from(rawData);
  } else if (rawData) {
    buffer = Buffer.from(rawData);
  } else {
    throw new Error('download_shipping_document: empty response');
  }

  if (buffer.length === 0) {
    throw new Error('download_shipping_document: empty buffer');
  }

  // ── 응답 유효성 체크: 에러 JSON이면 예외 throw ──────────────────
  const isPdf  = buffer.slice(0, 4).toString('ascii') === '%PDF';
  const isJson = buffer[0] === 0x7b; // '{'
  const isHtml = buffer.slice(0, 100).toString('utf8').toLowerCase().includes('<html');

  if (!isPdf) {
    const bodyText = buffer.slice(0, 600).toString('utf8');
    console.warn(`[Logistics] download_shipping_document NON-PDF [${orderSn}]: ${bodyText}`);

    if (isJson) {
      // 에러 JSON 응답 → 예외로 전환
      try {
        const errObj = JSON.parse(bodyText);
        throw new Error(
          `download_shipping_document API error: ${errObj.error} - ${errObj.message}`
        );
      } catch (parseErr) {
        if (parseErr.message.startsWith('download_shipping_document API error')) throw parseErr;
        throw new Error(`download_shipping_document: non-PDF non-parseable response (${buffer.length}B)`);
      }
    }
  }

  console.log(`[Logistics] download_shipping_document [${orderSn}] size=${buffer.length}B type=${isPdf ? 'PDF' : isHtml ? 'HTML' : 'BINARY'}`);
  return buffer;
}

// ─── 내부 헬퍼: docType 조회 ─────────────────────────────────────
/**
 * get_shipping_document_parameter 호출 후 해당 주문의 document type 반환
 * 하드코딩 금지 — 반드시 API 응답값 사용
 */
async function resolveDocType(shopId, orderSn, accessToken) {
  const docParams = await getShippingDocumentParameter(shopId, [orderSn], accessToken);
  const orderDoc  = docParams.find(d => d.order_sn === orderSn);
  console.log(`[Logistics] doc_parameter for ${orderSn}:`, JSON.stringify(orderDoc));

  const docType =
    orderDoc?.suggest_shipping_document_type          ||  // 실제 응답 필드명 (로그 확인됨)
    orderDoc?.suggested_shipping_document_type        ||  // 공식 문서 표기 대비
    orderDoc?.shipping_document_type                  ||
    orderDoc?.selectable_shipping_document_type?.[0]  ||
    null;

  if (!docType) {
    throw new Error(
      `document type 결정 불가 — orderDoc keys: ${orderDoc ? Object.keys(orderDoc).join(', ') : 'null'}`
    );
  }
  console.log(`[Logistics] resolved doc_type for ${orderSn}: ${docType}`);
  return docType;
}

// ─── 내부 헬퍼: create → poll → download 풀 플로우 ───────────────
async function createAndDownload(shopId, orderSn, docType, accessToken, trackingNumber) {
  // create — tracking_number가 있으면 order_list 항목에 포함 (공식 스펙)
  const orderEntry = { order_sn: orderSn, shipping_document_type: docType };
  if (trackingNumber) orderEntry.tracking_number = trackingNumber;

  const createResult = await createShippingDocument(
    shopId, [orderEntry], accessToken
  );
  const created = createResult[0];
  if (created?.fail_error && created.fail_error !== '') {
    const msg = `${created.fail_error} - ${created.fail_message}`;
    if (/can.?not print/i.test(created.fail_error)) {
      throw Object.assign(new Error(msg), { cannotPrint: true });
    }
    throw new Error(`create_shipping_document failed: ${msg}`);
  }

  // poll
  const pollResult = await pollShippingDocumentResult(shopId, [orderSn], accessToken, 30, 2000);
  const item = pollResult.find(r => r.order_sn === orderSn);
  if (item?.fail_error && item.fail_error !== '') {
    throw new Error(`document result error: ${item.fail_error}`);
  }

  // download
  return downloadShippingDocument(shopId, orderSn, docType, accessToken);
}

// ─── 통합 함수: 주문 1건 송장 다운로드 (상태에 따라 분기) ─────────
/**
 * 상태별 처리 전략:
 *
 *  UNPAID / PENDING / CANCELLED
 *    → 스킵 (송장 발행 불가)
 *
 *  READY_TO_SHIP
 *    → get_shipping_parameter → ship_order → get_tracking_number
 *    → get_shipping_document_parameter (docType 결정)
 *    → create → poll → download
 *
 *  PROCESSED
 *    → [캐시 확인] (캐시 히트 시 즉시 반환 — 상위 invoiceWorker에서 처리)
 *    → get_tracking_number (최신 tracking_number 확보)
 *    → get_shipping_document_parameter (docType 결정)
 *    → create_shipping_document → poll(READY) → download_shipping_document
 *
 *  SHIPPED / COMPLETED
 *    → docType 결정 → create → poll → download
 *    → 실패 시 skipped 처리 (허용)
 *
 * @returns {{ pdfBuffer, trackingNumber, skipped, reason }}
 */
async function processInvoiceForOrder({ shopId, orderSn, orderStatus, accessToken, existingTracking }) {
  console.log(`[Logistics] processInvoice START: ${orderSn} status=${orderStatus}`);

  // ── 1. 스킵 대상 ──────────────────────────────────────────────
  if (['UNPAID', 'PENDING', 'CANCELLED'].includes(orderStatus)) {
    return { pdfBuffer: null, trackingNumber: null, skipped: true, reason: `${orderStatus}: 송장 발행 불가` };
  }

  let trackingNumber = existingTracking || null;

  // ── 2. READY_TO_SHIP: 출고 처리 후 송장 생성 ─────────────────
  if (orderStatus === 'READY_TO_SHIP') {
    // shipSkipped=true: get_shipping_parameter 또는 ship_order에서
    // "not eligible for rescheduling" → 이미 PROCESSED 상태, 스킵
    let shipSkipped = false;
    let shippingParam = null;

    // get_shipping_parameter — already-shipped 에러 시 PROCESSED 플로우로 전환
    try {
      shippingParam = await getShippingParameter(shopId, orderSn, accessToken);
    } catch (paramErr) {
      if (isAlreadyShippedError(paramErr)) {
        console.warn(`[Logistics] get_shipping_parameter skipped (already shipped): ${orderSn} — ${paramErr.message}`);
        shipSkipped = true;
      } else {
        throw paramErr;
      }
    }

    // ship_order — already-shipped 에러 시 동일하게 PROCESSED 플로우로 전환
    if (!shipSkipped) {
      try {
        await shipOrder(shopId, orderSn, shippingParam, accessToken);
        console.log(`[Logistics] ship_order completed: ${orderSn}`);
        await sleep(3000); // Shopee 서버 반영 대기
      } catch (shipErr) {
        if (shipErr.alreadyShipped || isAlreadyShippedError(shipErr)) {
          console.warn(`[Logistics] ship_order skipped (already shipped): ${orderSn}`);
          shipSkipped = true;
        } else {
          throw shipErr;
        }
      }
    }

    trackingNumber = await getTrackingNumber(shopId, orderSn, accessToken);
    console.log(`[Logistics] tracking_number: ${trackingNumber}`);

    // docType 결정 후 create → poll → download
    // ⚠️ trackingNumber 반드시 전달 — create_shipping_document 필수 파라미터
    const docType = await resolveDocType(shopId, orderSn, accessToken);
    try {
      const pdfBuffer = await createAndDownload(shopId, orderSn, docType, accessToken, trackingNumber);
      // shipSkipped=true 이면 호출자(invoiceWorker)가 DB order_status → PROCESSED 업데이트
      return { pdfBuffer, trackingNumber, skipped: false, reason: null, statusUpdated: shipSkipped ? 'PROCESSED' : null };
    } catch (e) {
      if (e.cannotPrint) {
        return { pdfBuffer: null, trackingNumber, skipped: true, reason: `인쇄 불가 채널: ${e.message}`, statusUpdated: shipSkipped ? 'PROCESSED' : null };
      }
      throw e;
    }
  }

  // ── 3. PROCESSED: get_tracking_number → create → poll → download ─
  if (orderStatus === 'PROCESSED') {
    // 3-a. 최신 tracking_number 확보 (Shopee 요구사항)
    console.log(`[Logistics] PROCESSED — get_tracking_number: ${orderSn}`);
    const freshTracking = await getTrackingNumber(shopId, orderSn, accessToken);
    if (freshTracking) {
      trackingNumber = freshTracking;
      console.log(`[Logistics] tracking_number: ${trackingNumber}`);
    } else {
      console.warn(`[Logistics] tracking_number 없음 (계속 진행): ${orderSn}`);
    }

    // 3-b. docType 결정
    const docType = await resolveDocType(shopId, orderSn, accessToken);

    // 3-c. create → poll → download (trackingNumber 전달 — 공식 스펙 required)
    try {
      console.log(`[Logistics] PROCESSED — create_shipping_document: ${orderSn} (${docType}) tracking=${trackingNumber || 'none'}`);
      const pdfBuffer = await createAndDownload(shopId, orderSn, docType, accessToken, trackingNumber);
      return { pdfBuffer, trackingNumber, skipped: false, reason: null };
    } catch (e) {
      if (e.cannotPrint) {
        return { pdfBuffer: null, trackingNumber, skipped: true, reason: `인쇄 불가 채널: ${e.message}` };
      }
      throw e;
    }
  }

  // ── 4. SHIPPED / COMPLETED: create → poll → download (실패 시 허용) ─
  const isAlreadyShipped = ['SHIPPED', 'COMPLETED'].includes(orderStatus);

  let docType;
  try {
    docType = await resolveDocType(shopId, orderSn, accessToken);
  } catch (e) {
    console.error(`[Logistics] resolveDocType failed for ${orderSn}: ${e.message}`);
    if (isAlreadyShipped) {
      return { pdfBuffer: null, trackingNumber, skipped: true, reason: `docType 조회 실패: ${e.message}` };
    }
    throw e;
  }

  try {
    console.log(`[Logistics] ${orderStatus} — create_shipping_document: ${orderSn} (${docType})`);
    const pdfBuffer = await createAndDownload(shopId, orderSn, docType, accessToken);
    return { pdfBuffer, trackingNumber, skipped: false, reason: null };
  } catch (e) {
    if (e.cannotPrint) {
      return { pdfBuffer: null, trackingNumber, skipped: true, reason: `인쇄 불가 채널: ${e.message}` };
    }
    if (isAlreadyShipped) {
      console.warn(`[Logistics] create 실패 (SHIPPED/COMPLETED 허용): ${orderSn}: ${e.message}`);
      return { pdfBuffer: null, trackingNumber, skipped: true, reason: `송장 다운로드 불가: ${e.message}` };
    }
    throw e;
  }
}

module.exports = {
  getShippingParameter,
  shipOrder,
  getTrackingNumber,
  getShippingDocumentParameter,
  createShippingDocument,
  pollShippingDocumentResult,
  downloadShippingDocument,
  processInvoiceForOrder,
};
