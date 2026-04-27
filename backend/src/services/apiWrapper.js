/**
 * Shopee API 공통 재시도 래퍼
 * - Rate Limit (429): Exponential Backoff 5s → 15s → 45s, 최대 3회
 * - 인증 에러: 토큰 즉시 갱신 후 재시도
 * - 서버 에러 (5xx): 10s 간격 3회
 * - 타임아웃: 즉시 1회 재시도
 * - 비즈니스 에러: 재시도 없음, 로그 + 스킵
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
 * @param {Function} requestFn - async function that makes the axios call
 * @param {Object} options
 * @param {Function} options.onAuthError - async callback to refresh token
 * @param {string} options.context - description for logging
 */
async function callWithRetry(requestFn, options = {}) {
  const { onAuthError = null, context = 'Shopee API' } = options;

  let lastError;
  let tokenRefreshed = false;

  // For each attempt type
  const attempt = async (retryCount = 0, maxRetries = 3) => {
    try {
      const response = await requestFn();
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
        if ((errCode === 'error_auth' || errCode === 'invalid_access_token') && !tokenRefreshed && onAuthError) {
          console.warn(`[${context}] Auth error, refreshing token...`);
          tokenRefreshed = true;
          await onAuthError();
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
    const url = error.config?.url?.split('?')[0];
    console.error(`[Shopee API] ✗ ${status || 'NETWORK'} ${url}`);
    return Promise.reject(error);
  }
);

module.exports = { callWithRetry, shopeeAxios, sleep };
