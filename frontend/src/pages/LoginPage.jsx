import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const nextPath = location.state?.from?.pathname || '/orders';

  if (isAuthenticated) {
    return <Navigate to={nextPath} replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(password);
      navigate(nextPath, { replace: true });
    } catch (err) {
      setError(err.message || '로그인에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand login-brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>Shopee Admin</strong>
            <small>Internal Operations</small>
          </div>
        </div>
        <label>
          관리자 비밀번호
          <input
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoFocus
            placeholder="Password"
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" disabled={submitting || !password}>
          {submitting ? '로그인 중...' : '로그인'}
        </button>
      </form>
    </div>
  );
}
