import { apiRequest, buildQuery } from './client.js';

export async function fetchReceiptDashboard() {
  return apiRequest('/api/receipts/dashboard');
}

export async function fetchSkuCompositions(query = '') {
  return apiRequest(`/api/receipts/sku-compositions${buildQuery({ q: query })}`);
}
