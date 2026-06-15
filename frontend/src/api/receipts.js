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

export async function fetchStockReceipts(params = {}) {
  return apiRequest(`/api/receipts/stock-receipts${buildQuery(params)}`);
}

export function createStockReceipt(payload) {
  return apiRequest('/api/receipts/stock-receipts', {
    method: 'POST',
    body: payload,
  });
}

export function completeStockReceipt(id) {
  return apiRequest(`/api/receipts/stock-receipts/${id}/complete`, {
    method: 'POST',
  });
}

export function cancelStockReceipt(id, payload = {}) {
  return apiRequest(`/api/receipts/stock-receipts/${id}/cancel`, {
    method: 'POST',
    body: payload,
  });
}
