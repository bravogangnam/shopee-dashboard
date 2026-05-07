import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { register } from '../api/auth.js';
import { useAuth } from '../auth/AuthContext.jsx';

export default function RegisterPage() {
  const { isAuthenticated } = useAuth();
  const [form, setForm] = useState({
    email: '',
    password: '',
    passwordConfirm: '',
    requestedMainAccountId: '',
    phone: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (isAuthenticated) {
    return <Navigate to="/orders" replace />;
  }

  function setField(key, value) {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  function validate() {
    const email = form.email.trim().toLowerCase();
    const mainAccountId = form.requestedMainAccountId.trim();
    const phone = form.phone.trim();

    if (!email) return '이메일을 입력하세요.';
    if (!email.includes('@')) return '올바른 이메일을 입력하세요.';
    if (!form.password || form.password.length < 8) return '비밀번호는 최소 8자 이상이어야 합니다.';
    if (form.password !== form.passwordConfirm) return '비밀번호 확인이 일치하지 않습니다.';
    if (!/^\d+$/.test(mainAccountId)) return 'Shopee Main Account ID는 숫자만 입력하세요.';
    if (mainAccountId === '0') return 'Shopee Main Account ID를 확인하세요.';
    if (!phone) return '연락처를 입력하세요.';
    if (phone.length > 50) return '연락처는 50자 이하로 입력하세요.';

    return '';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);

    try {
      const response = await register({
        email: form.email.trim().toLowerCase(),
        password: form.password,
        requested_main_account_id: form.requestedMainAccountId.trim(),
        phone: form.phone.trim(),
      });

      setResult(response);
    } catch (err) {
      const details = Array.isArray(err.payload?.details)
        ? err.payload.details.join(', ')
        : '';

      setError(details || err.message || '가입 신청에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="login-page">
        <div className="login-card register-result-card">
          <div className="brand login-brand">
            <span className="brand-mark">S</span>
            <div>
              <strong>가입 신청 완료</strong>
              <small>승인 대기중</small>
            </div>
          </div>

          <div className="register-success-box">
            <h1>관리자 승인 대기중입니다.</h1>
            <p>
              신청이 접수되었습니다. 관리자가 승인하면 로그인 후 사용할 수 있습니다.
            </p>
            <dl>
              <dt>이메일</dt>
              <dd>{result.user?.email || form.email.trim().toLowerCase()}</dd>
              <dt>Tenant 상태</dt>
              <dd>{result.tenant?.approval_status || result.approval_status || 'pending'}</dd>
              <dt>Main Account ID</dt>
              <dd>{result.tenant?.requested_main_account_id || form.requestedMainAccountId.trim()}</dd>
            </dl>
          </div>

          <Link className="login-secondary-link" to="/login">
            로그인 화면으로 돌아가기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card register-card" onSubmit={handleSubmit}>
        <div className="brand login-brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>Shopee 가입 신청</strong>
            <small>관리자 승인 후 사용 가능</small>
          </div>
        </div>

        <label>
          이메일
          <input
            type="email"
            value={form.email}
            onChange={(event) => setField('email', event.target.value)}
            autoFocus
            autoComplete="username"
            placeholder="email@example.com"
          />
        </label>

        <label>
          비밀번호
          <input
            type="password"
            value={form.password}
            onChange={(event) => setField('password', event.target.value)}
            autoComplete="new-password"
            placeholder="8자 이상"
          />
        </label>

        <label>
          비밀번호 확인
          <input
            type="password"
            value={form.passwordConfirm}
            onChange={(event) => setField('passwordConfirm', event.target.value)}
            autoComplete="new-password"
            placeholder="비밀번호 재입력"
          />
        </label>

        <label>
          Shopee Main Account ID
          <input
            value={form.requestedMainAccountId}
            onChange={(event) => setField('requestedMainAccountId', event.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric"
            placeholder="예: 4627022"
          />
        </label>

        <label>
          연락처
          <input
            value={form.phone}
            onChange={(event) => setField('phone', event.target.value)}
            autoComplete="tel"
            placeholder="010-0000-0000"
          />
        </label>

        {error ? <p className="error-text">{error}</p> : null}

        <button
          type="submit"
          disabled={
            submitting ||
            !form.email.trim() ||
            !form.password ||
            !form.passwordConfirm ||
            !form.requestedMainAccountId.trim() ||
            !form.phone.trim()
          }
        >
          {submitting ? '신청 중...' : '가입 신청'}
        </button>

        <Link className="login-secondary-link" to="/login">
          이미 계정이 있나요? 로그인
        </Link>
      </form>
    </div>
  );
}
