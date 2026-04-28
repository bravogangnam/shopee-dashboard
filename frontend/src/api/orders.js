import { apiRequest, buildQuery } from './client.js';

export function fetchOrders(params) {
  return apiRequest(`/api/orders${buildQuery(params)}`);
}
