import { apiRequest } from './client.js';

export function fetchPaymentBalances() {
  return apiRequest('/api/payment-balances');
}

export function refreshPaymentBalances() {
  return apiRequest('/api/payment-balances/refresh', {
    method: 'POST',
  });
}
