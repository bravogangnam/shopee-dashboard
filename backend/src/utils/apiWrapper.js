/**
 * Shopee API 공통 재시도 래퍼
 * - Rate Limit (429): Exponential Backoff 5s → 15s → 45s, 최대 3회
 * - 인증 에러 / HTTP 403·401: 토큰 강제 갱신 + URL 재서명 후 재시도
 * - 서버 에러 (5xx): 10s 간격 3회
 * - 타임아웃: 즉시 1회 재시도
 * - 비즈니스 에러: 재시도 없음, 로그 + 스킵
 *
 * ── 토큰 갱신 후 URL 재서명 흐름 ──────────────────────────────────
 * Shopee sign = HMAC(partner_id + path + timestamp + access_token + shop_id)
 * 토큰 갱신 후에는 access_token + timestamp가 바뀌므로 sign도 재계산해야 함.
 *
 * options.rebuildRequest:
 *   async (newAccessToken: string) => () => Promise<AxiosResponse>
 *   - 토큰 갱신 성공 시 호출되며, 새 access_token을 받아 URL을 재서명하고
 *     새 requestFn을 반환한다.
 *   - 이 옵션이 없으면 기존 requestFn(구 URL)으로 재시도한다. (하위 호환)
 */

const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Shopee API error codes that mean business errors (no retry)
const BUSINESS_ERROR_CODES = [
  -1, // System error (sometimes)
  -2, // Access denied
];

/**
 * Core API call with retry logic
 * @param {Function} requestFn            - async () => AxiosResponse
 * @param {Object}   options
 * @param {Function} options.onAuthError  - async () => void  (토큰 갱신)
 * @param {Function} options.rebuildRequest
 *   - async (newAccessToken: string) => (() => Promise<AxiosResponse>)
 *   - 토큰 갱신 후 새 access_token으로 URL 재서명한 requestFn을 반환
 * @param {string}   options.context      - 로그 식별자
 */
async function callWithRetry(requestFn, options = {}) {
  const { onAuthError = null, rebuildRequest = null, context = 'Shopee API' } = options;

  let lastError;
  let tokenRefreshed = false;
  let currentRequestFn = requestFn; // 토큰 갱신 후 교체될 수 있음

  /**
   * 토큰 갱신 + URL 재서명 공통 처리
   * @returns {boolean} 갱신 성공 여부
   */
  const handleAuthRefresh = async () => {
    if (tokenRefreshed || !onAuthError) return false;
    tokenRefreshed = true;

    // 1) 토큰 강제 갱신
    await onAuthError();

    // 2) rebuildRequest가 있으면 새 access_token으로 URL 재서명
    if (rebuildRequest) {
      try {
        const { getMainAccount } = require('../services/shopeeAuth');
        const account = await getMainAccount();
        const newToken = account?.access_token;
        if (newToken) {
          currentRequestFn = await rebuildRequest(newToken);
          console.log(`[${context}] URL re-signed with new access_token.`);
        } else {
          console.warn(`[${context}] rebuildRequest: no new token in DB, using old URL.`);
        }
      } catch (e) {
        console.warn(`[${context}] rebuildRequest failed: ${e.message} — using old URL.`);
      }
    } else {
      console.warn(`[${context}] No rebuildRequest provided — retrying with OLD sign/timestamp (may fail).`);
    }

    return true;
  };

  // For each attempt type
  const attempt = async (retryCount = 0, maxRetries = 3) => {
    try {
      const response = await currentRequestFn();
      const data = response.data;

      // arraybuffer 응답 (download_shipping_document 등 바이너리 파일 응답)
      // → JSON 파싱 없이 그대로 반환
      if (response.config?.responseType === 'arraybuffer') {
        return data;
      }

      // Check Shopee business error codes
      if (data && data.error && data.error !== '') {
        const errCode = data.error;
        const errMsg = data.message || '';

        // Auth errors - refresh token and retry once
        // 'error_auth', 'invalid_access_token': Shopee 공식 auth 에러 코드
        const isAuthErr = errCode === 'error_auth'
          || errCode === 'invalid_access_token'
          || errCode === 'error_permission'
          || errMsg.toLowerCase().includes('access token');
        if (isAuthErr && !tokenRefreshed && onAuthError) {
          console.warn(`[${context}] Auth error (${errCode}), refreshing token + re-signing URL...`);
          await handleAuthRefresh();
          return attempt(0, 1); // one more try after token refresh
        }

        // Business errors - no retry
        console.error(`[${context}] Business error: ${errCode} - ${errMsg}`);
        // result_list가 있으면 세부 내용도 함께 출력 (batch_api_all_failed 디버깅용)
        if (data.response?.result_list) {
          console.error(`[${context}] result_list:`, JSON.stringify(data.response.result_list));
        }
        const err = new Error(`Shopee API Business Error: ${errCode} - ${errMsg}`);
        err.isBusinessError = true;
        err.shopeeError = errCode;
        err.responseData = data; // 원본 응답 보존
        throw err;
      }

      return data;
    } catch (err) {
      if (err.isBusinessError) throw err;

      const status = err.response?.status;

      // HTTP 403 Forbidden → 토큰 무효 (Shopee 서버 측 무효화)
      // body에 error 코드 없이 바로 403이 오는 경우 처리
      if (status === 403 && !tokenRefreshed && onAuthError) {
        console.warn(`[${context}] HTTP 403 received, forcing token refresh + re-signing URL...`);
        await handleAuthRefresh();
        return attempt(0, 1); // 토큰 갱신 후 1회 재시도
      }

      // HTTP 401 Unauthorized → 동일하게 처리
      if (status === 401 && !tokenRefreshed && onAuthError) {
        console.warn(`[${context}] HTTP 401 received, forcing token refresh + re-signing URL...`);
        await handleAuthRefresh();
        return attempt(0, 1);
      }

      // Rate limit (429) - exponential backoff
      if (status === 429) {
        const delays = [5000, 15000, 45000];
        if (retryCount < 3) {
          const delay = delays[retryCount] || 45000;
          console.warn(`[${context}] Rate limited. Retry ${retryCount + 1}/3 after ${delay}ms`);
          await sleep(delay);
          return attempt(retryCount + 1, maxRetries);
        }
      }

      // Server errors (5xx) - 10s interval, 3 retries
      if (status >= 500 && status < 600) {
        if (retryCount < 3) {
          console.warn(`[${context}] Server error ${status}. Retry ${retryCount + 1}/3 after 10s`);
          await sleep(10000);
          return attempt(retryCount + 1, maxRetries);
        }
      }

      // Timeout - immediate 1 retry
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        if (retryCount < 1) {
          console.warn(`[${context}] Timeout. Retrying immediately...`);
          return attempt(retryCount + 1, maxRetries);
        }
      }

      lastError = err;
      throw err;
    }
  };

  return attempt();
}

/**
 * Create axios instance for Shopee API
 */
const shopeeAxios = axios.create({
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for logging
shopeeAxios.interceptors.request.use(
  (config) => {
    // Remove access_token from log for security
    const url = config.url?.replace(/access_token=[^&]+/, 'access_token=***');
    console.log(`[Shopee API] → ${config.method?.toUpperCase()} ${url}`);
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor for logging
shopeeAxios.interceptors.response.use(
  (response) => {
    const endpoint = response.config.url?.split('?')[0];
    const contentType = response.headers?.['content-type'] || 'unknown';
    const responseType = response.config?.responseType;

    // arraybuffer 응답 (download_shipping_document 등) — Content-Type + 크기 + hex 헤더 로깅
    if (responseType === 'arraybuffer') {
      const buf = response.data instanceof ArrayBuffer
        ? Buffer.from(response.data)
        : Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || []);
      const hexHead = buf.slice(0, 16).toString('hex').replace(/../g, '$& ').trim();
      const isPdf  = buf.slice(0, 4).toString('ascii') === '%PDF';
      const isJson = buf[0] === 0x7b;
      const isHtml = buf.slice(0, 100).toString('utf8').toLowerCase().includes('<html');
      const typeLabel = isPdf ? 'PDF' : isJson ? 'JSON' : isHtml ? 'HTML' : 'BINARY';
      console.log(
        `[Shopee API] ← ${response.status} ${endpoint}` +
        ` | Content-Type: ${contentType}` +
        ` | size: ${buf.length}B` +
        ` | bodyType: ${typeLabel}` +
        ` | hex16: ${hexHead}`
      );
      if (!isPdf && buf.length < 2000) {
        // 에러 JSON 등 소형 응답은 텍스트로 전체 출력
        console.warn(`[Shopee API] NON-PDF body: ${buf.toString('utf8').slice(0, 500)}`);
      }
    } else {
      console.log(`[Shopee API] ← ${response.status} ${endpoint}`);
    }
    return response;
  },
  (error) => {
    const status = error.response?.status;
    // 전체 URL (query params 포함, access_token만 마스킹) — 디버깅용
    const fullUrl = error.config?.url?.replace(/access_token=[^&]+/, 'access_token=***') || '(no url)';
    const method  = (error.config?.method || '?').toUpperCase();

    console.error(`[Shopee API] ✗ ${status || 'NETWORK'} ${method} ${fullUrl}`);

    // 4xx/5xx 응답이 있는 경우 응답 body도 출력 (원인 파악용)
    if (error.response?.data) {
      const rawData = error.response.data;
      try {
        if (rawData instanceof ArrayBuffer || Buffer.isBuffer(rawData)) {
          const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
          console.error(`[Shopee API] ✗ response body (binary ${buf.length}B): ${buf.slice(0, 300).toString('utf8')}`);
        } else if (typeof rawData === 'string') {
          console.error(`[Shopee API] ✗ response body: ${rawData.slice(0, 500)}`);
        } else {
          console.error(`[Shopee API] ✗ response body:`, JSON.stringify(rawData).slice(0, 500));
        }
      } catch (e) {
        console.error(`[Shopee API] ✗ response body (unparseable)`);
      }
    }

    return Promise.reject(error);
  }
);

module.exports = { callWithRetry, shopeeAxios, sleep };
