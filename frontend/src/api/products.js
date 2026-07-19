import { apiRequest, buildQuery } from './client.js';

function skuPath(sku) {
  return encodeURIComponent(sku);
}

export async function fetchLowStockProducts() {
  const result = await apiRequest('/api/products/low-stock');
  return result.data || [];
}

export async function fetchInventoryProducts() {
  const result = await apiRequest(`/api/products/low-stock${buildQuery({ scope: 'all' })}`);
  return {
    data: result.data || [],
    summary: result.summary || null,
  };
}

export async function fetchTodayOrderInventory() {
  const result = await apiRequest('/api/products/inventory/today-orders');
  return {
    data: result.data || [],
    summary: result.summary || null,
  };
}

export function updateProductStock(sku, payload) {
  return apiRequest(`/api/products/${skuPath(sku)}/stock`, {
    method: 'PATCH',
    body: payload,
  });
}

export function adjustProductStock(sku, payload) {
  return apiRequest(`/api/products/${skuPath(sku)}/stock/adjust`, {
    method: 'POST',
    body: payload,
  });
}

export function adjustProductStartBalance(sku, payload) {
  return apiRequest(`/api/products/${skuPath(sku)}/stock/start-balance-adjust`, {
    method: 'POST',
    body: payload,
  });
}

export function syncInventoryReceipts() {
  return apiRequest('/api/products/inventory-receipts/sync', {
    method: 'POST',
  });
}

export async function fetchInventoryMovements(sku, limit = 50) {
  const result = await apiRequest(
    `/api/products/${skuPath(sku)}/inventory-movements${buildQuery({ limit })}`
  );
  return result.data || [];
}

export async function fetchCancellationInventoryReviews(decision = '') {
  const result = await apiRequest(`/api/products/inventory/cancellation-reviews${buildQuery({ decision, limit: 200 })}`);
  return result.data || [];
}

export function restoreCancellationInventory(shopId, orderSn) {
  return apiRequest(`/api/products/inventory/cancellation-reviews/${encodeURIComponent(shopId)}/${encodeURIComponent(orderSn)}/restore`, {
    method: 'POST',
  });
}
