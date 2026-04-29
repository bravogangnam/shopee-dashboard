import { NavLink, Outlet } from 'react-router-dom';

export default function AppLayout() {
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
            정산 관리
          </NavLink>
          <a href="/settings" className="nav-link">설정</a>
        </nav>
      </aside>
      <main className="main content">
        <Outlet />
      </main>
    </div>
  );
}
