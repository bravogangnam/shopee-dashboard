import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

function LedgerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3h8l4 4v14H7z" />
      <path d="M15 3v5h5M10 13h7M10 17h7M10 9h2" />
    </svg>
  );
}

function InventoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 8 12 3 3 8l9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8M12 13v8" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-2.8 8.6-7 10-4.2-1.4-7-5.5-7-10V6l7-3zm0 2.2L7 7.3V11c0 3.5 1.9 6.7 5 8 3.1-1.3 5-4.5 5-8V7.3l-5-2.1z" />
      <path d="M11 8h2v4h-2V8zm0 6h2v2h-2v-2z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2.1 2.1 0 0 1-2.97 2.97l-.04-.04a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.66V21a2.1 2.1 0 0 1-4.2 0v-.06a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-1.98.36l-.04.04a2.1 2.1 0 1 1-2.97-2.97l.04-.04A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.66-1.1H3a2.1 2.1 0 0 1 0-4.2h.06A1.8 1.8 0 0 0 4.72 8.6a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2.1 2.1 0 0 1 2.97-2.97l.04.04A1.8 1.8 0 0 0 9 4.6a1.8 1.8 0 0 0 1.1-1.66V3a2.1 2.1 0 0 1 4.2 0v.06A1.8 1.8 0 0 0 15.4 4.72a1.8 1.8 0 0 0 1.98-.36l.04-.04a2.1 2.1 0 0 1 2.97 2.97l-.04.04A1.8 1.8 0 0 0 19.4 9c.48.18 1 .28 1.6.28h.06a2.1 2.1 0 0 1 0 4.2H21a1.8 1.8 0 0 0-1.6 1.1Z" />
    </svg>
  );
}

function ToggleIcon({ collapsed }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
    </svg>
  );
}

const navItems = [
  { to: '/orders', label: '주문 관리', icon: <ListIcon /> },
  { to: '/ledger', label: '정산 관리', icon: <LedgerIcon /> },
  { to: '/inventory', label: '재고 관리', icon: <InventoryIcon /> },
  { to: '/admin', label: '관리자', icon: <AdminIcon />, adminOnly: true },
  { to: '/settings', label: '설정', icon: <SettingsIcon /> },
];

export default function AppLayout() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.is_platform_admin === 1 || user?.is_platform_admin === true || user?.is_platform_admin === '1';
  const [collapsed, setCollapsed] = useState(false);
  const visibleNavItems = navItems.filter((item) => !item.adminOnly || isPlatformAdmin);

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="brand-area">
            <img src="/logo.png" alt="Jun's & Kang's" className="brand-logo" />
            {!collapsed && <strong className="brand-name">Jun&apos;s &amp; Kang&apos;s</strong>}
          </div>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setCollapsed(value => !value)}
            aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
            title={collapsed ? '펼치기' : '접기'}
          >
            <ToggleIcon collapsed={collapsed} />
          </button>
        </div>
        <nav className="sidebar-nav">
          {visibleNavItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-text">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className={`main content main-content ${collapsed ? 'collapsed' : ''}`}>
        <Outlet />
      </main>
    </div>
  );
}
