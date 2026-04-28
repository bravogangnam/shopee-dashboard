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
          <span className="brand-mark">S</span>
          <div>
            <strong>Shopee Admin</strong>
            <small>Order Operations</small>
          </div>
        </div>
        <nav className="nav">
          <NavLink to="/orders">주문 목록</NavLink>
          <NavLink to="/settings/rates">환율 설정</NavLink>
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
