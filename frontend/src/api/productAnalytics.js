import { apiRequest, buildQuery } from './client.js';

export function fetchProductAnalytics(params = {}) {
  return apiRequest(`/api/product-analytics/overview${buildQuery(params)}`);
}

export function fetchProductAnalyticsDetail(sku, params = {}) {
  return apiRequest(`/api/product-analytics/sku/${encodeURIComponent(sku)}${buildQuery(params)}`);
}
