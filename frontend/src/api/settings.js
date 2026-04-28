import { apiRequest } from './client.js';

export function fetchRates() {
  return apiRequest('/api/settings/rates');
}
