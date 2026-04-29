import { apiRequest } from './client.js';

export function fetchRates() {
  return apiRequest('/api/settings/rates');
}

export function saveRates(rates) {
  return apiRequest('/api/settings/rates', {
    method: 'PUT',
    body: { rates },
  });
}

export function addRate(currency, rate_to_krw) {
  return apiRequest('/api/settings/rates', {
    method: 'POST',
    body: { currency, rate_to_krw },
  });
}

export function deleteRate(currency) {
  return apiRequest(`/api/settings/rates/${encodeURIComponent(currency)}`, {
    method: 'DELETE',
  });
}

export function fetchAccount() {
  return apiRequest('/api/settings/account');
}

export function saveAccount(data) {
  return apiRequest('/api/settings/account', {
    method: 'PUT',
    body: data,
  });
}

export function fetchShops() {
  return apiRequest('/api/settings/shops');
}

export function updateShop(shopId, data) {
  return apiRequest(`/api/settings/shops/${encodeURIComponent(shopId)}`, {
    method: 'PUT',
    body: data,
  });
}

export function fetchTokenStatus() {
  return apiRequest('/api/auth/status');
}

export function refreshToken() {
  return apiRequest('/api/auth/shopee/refresh', {
    method: 'POST',
  });
}

export function getShopeeAuthUrl() {
  return apiRequest('/api/auth/shopee/url');
}

export function testConnection() {
  return apiRequest('/api/test/shopee-connection');
}

export function startBackfill() {
  return apiRequest('/api/jobs/backfill', {
    method: 'POST',
  });
}

export function getJobStatus(jobId) {
  return apiRequest(`/api/jobs/${encodeURIComponent(jobId)}/status`);
}
