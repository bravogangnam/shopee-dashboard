import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function AppLayout() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.png" alt="Jun's & Kang's" className="brand-logo" />
          <strong className="brand-name">Jun&apos;s &amp; Kang&apos;s</strong>
        </div>
        <nav className="nav">
          <a href="/orders" className="nav-link">주문 관리</a>
          <NavLink
            to="/orders"
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          >
            정산목록
          </NavLink>
          <a href="/settings" className="nav-link">설정</a>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <strong>관리자 대시보드</strong>
            <span>주문, 정산, 원가 확인</span>
          </div>
          <button className="ghost-button" type="button" onClick={handleLogout}>로그아웃</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
