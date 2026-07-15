import { apiRequest, buildQuery } from './client.js';

export function fetchOrders(params) {
  return apiRequest(`/api/orders${buildQuery(params)}`);
}

export function fetchStats(params = {}) {
  const searchParams = {
    date_from: params.date_from,
    date_to: params.date_to,
  };
  return apiRequest(`/api/orders/stats${buildQuery(searchParams)}`);
}

export async function fetchSummary(params) {
  const result = await apiRequest(`/api/orders/summary${buildQuery(params)}`);
  return result.summary || null;
}

export async function fetchDailySales(month) {
  const result = await apiRequest(`/api/orders/daily-sales${buildQuery({ month })}`);
  return {
    month: result.month,
    data: result.data || [],
  };
}


export function fetchOrderDetail(orderSn, shopId) {
  const params = {};
  if (shopId !== null && shopId !== undefined && shopId !== '') {
    params.shop_id = shopId;
  }
  return apiRequest(`/api/orders/${encodeURIComponent(orderSn)}${buildQuery(params)}`);
}
