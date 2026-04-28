import { apiRequest, buildQuery } from './client.js';

export function fetchOrders(params) {
  return apiRequest(`/api/orders${buildQuery(params)}`);
}

export async function fetchSummary(params) {
  const result = await apiRequest(`/api/orders/summary${buildQuery(params)}`);
  return result.summary || null;
}
