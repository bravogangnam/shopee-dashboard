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
    method: 'PATCH',
    body: data,
  });
}

export function syncShopProfiles() {
  return apiRequest('/api/settings/shops/sync-profile', {
    method: 'POST',
  });
}


export function cleanupShippingLabels() {
  return apiRequest('/api/settings/shipping-labels/cleanup', {
    method: 'POST',
  });
}

export function fetchServerStorage() {
  return apiRequest('/api/settings/server-storage');
}

export function cleanupServerStorage() {
  return apiRequest('/api/settings/server-storage/cleanup', {
    method: 'POST',
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

export function getShopeeAuthUrl({ purpose = 'connect_main_account' } = {}) {
  const query = new URLSearchParams({ purpose }).toString();
  return apiRequest(`/api/auth/shopee/url?${query}`);
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

export function fetchGoogleSheetSettings() {
  return apiRequest('/api/settings/google-sheet');
}

export function updateGoogleSheetSettings(payload) {
  return apiRequest('/api/settings/google-sheet', {
    method: 'PUT',
    body: {
      google_sheet_id: payload.google_sheet_id,
    },
  });
}

export function testMarginChartSheet() {
  return apiRequest('/api/settings/google-sheet/chart/test', {
    method: 'POST',
    body: {},
  });
}

export function syncMarginChartSheet() {
  return apiRequest('/api/settings/google-sheet/chart/sync', {
    method: 'POST',
    body: {},
  });
}
