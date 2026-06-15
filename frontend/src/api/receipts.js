import { apiRequest, buildQuery } from './client.js';

export async function fetchReceiptDashboard() {
  return apiRequest('/api/receipts/dashboard');
}

export async function searchReceiptProducts(query = '') {
  return apiRequest(`/api/receipts/product-search${buildQuery({ q: query })}`);
}

export async function fetchSkuCompositions(query = '') {
  return apiRequest(`/api/receipts/sku-compositions${buildQuery({ q: query })}`);
}

export function createSkuComposition(payload) {
  return apiRequest('/api/receipts/sku-compositions', {
    method: 'POST',
    body: payload,
  });
}

export function updateSkuComposition(id, payload) {
  return apiRequest(`/api/receipts/sku-compositions/${id}`, {
    method: 'PATCH',
    body: payload,
  });
}

export function deleteSkuComposition(id) {
  return apiRequest(`/api/receipts/sku-compositions/${id}`, {
    method: 'DELETE',
  });
}
