import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { checkAuth, login as loginRequest, logout as logoutRequest } from '../api/auth.js';
import { clearStoredToken, getStoredToken, storeToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => getStoredToken());
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function verify() {
      if (!getStoredToken()) {
        setReady(true);
        return;
      }

      try {
        const result = await checkAuth();
        if (!cancelled) {
          setUser(result.user || { authenticated: true });
        }
      } catch (_) {
        clearStoredToken();
        if (!cancelled) {
          setToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    verify();
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(password) {
    const result = await loginRequest(password);
    storeToken(result.token);
    setToken(result.token);
    setUser({ authenticated: true });
    return result;
  }

  async function logout() {
    try {
      await logoutRequest();
    } catch (_) {
      // Local cleanup still matters if the server session is already gone.
    }
    clearStoredToken();
    setToken(null);
    setUser(null);
  }

  const value = useMemo(() => ({
    ready,
    token,
    user,
    isAuthenticated: Boolean(token),
    login,
    logout,
  }), [ready, token, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}
