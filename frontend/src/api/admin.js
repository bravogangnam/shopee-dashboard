import { apiRequest } from './client.js';

function buildQuery(params = {}) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, value);
    }
  });

  const query = search.toString();
  return query ? `?${query}` : '';
}

export function fetchAdminTenants(params = {}) {
  return apiRequest(`/api/admin/tenants${buildQuery(params)}`);
}

export function fetchAdminUsers() {
  return apiRequest('/api/admin/users');
}

export function approveTenant(tenantId) {
  return apiRequest(`/api/admin/tenants/${encodeURIComponent(tenantId)}/approve`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
}

export function rejectTenant(tenantId, reason = '') {
  return apiRequest(`/api/admin/tenants/${encodeURIComponent(tenantId)}/reject`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
}

export function suspendTenant(tenantId, reason = '') {
  return apiRequest(`/api/admin/tenants/${encodeURIComponent(tenantId)}/suspend`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
}
