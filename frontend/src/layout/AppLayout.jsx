import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <img src="/logo.png" alt="Jun's & Kang's" className="brand-logo" />
          <strong className="brand-name">Jun&apos;s &amp; Kang&apos;s</strong>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setCollapsed(value => !value)}
            aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
            title={collapsed ? '펼치기' : '접기'}
          >
            {collapsed ? '>' : '<'}
          </button>
        </div>
        <nav className="nav">
          <a href="/orders" className="nav-link">
            <span className="nav-icon" aria-hidden="true">주</span>
            <span className="nav-text">주문 관리</span>
          </a>
          <NavLink
            to="/orders"
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          >
            <span className="nav-icon" aria-hidden="true">정</span>
            <span className="nav-text">정산 관리</span>
          </NavLink>
          <a href="/settings" className="nav-link">
            <span className="nav-icon" aria-hidden="true">설</span>
            <span className="nav-text">설정</span>
          </a>
        </nav>
      </aside>
      <main className={`main content main-content ${collapsed ? 'collapsed' : ''}`}>
        <Outlet />
      </main>
    </div>
  );
}
