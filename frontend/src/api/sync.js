import { apiRequest } from './client.js';

export function startSync() {
  return apiRequest('/api/jobs/sync', {
    method: 'POST',
    body: {},
  });
}
