import { apiRequest } from './client.js';

export function login(password) {
  return apiRequest('/api/auth/login', {
    method: 'POST',
    body: { password },
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
