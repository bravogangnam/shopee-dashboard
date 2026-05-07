import { apiRequest } from './client.js';

export function login(credentials) {
  const payload = typeof credentials === 'string'
    ? { password: credentials }
    : credentials || {};

  return apiRequest('/api/auth/login', {
    method: 'POST',
    body: {
      email: payload.email,
      password: payload.password,
    },
  });
}

export function logout() {
  return apiRequest('/api/auth/logout', {
    method: 'POST',
  });
}

export function checkAuth() {
  return apiRequest('/api/auth/check');
}

export function register(payload) {
  return apiRequest('/api/auth/register', {
    method: 'POST',
    body: {
      email: payload.email,
      password: payload.password,
      requested_main_account_id: payload.requested_main_account_id,
      phone: payload.phone,
    },
  });
}
