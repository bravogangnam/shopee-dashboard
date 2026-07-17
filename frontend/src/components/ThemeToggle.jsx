import { useEffect, useState } from 'react';

const STORAGE_KEY = 'shopee-dashboard-theme';

function getInitialTheme() {
  if (typeof window === 'undefined') return 'light';

  const savedTheme = window.localStorage.getItem(STORAGE_KEY);
  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export default function ThemeToggle({ collapsed = false }) {
  const [theme, setTheme] = useState(getInitialTheme);
  const isDark = theme === 'dark';

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  function handleToggle() {
    setTheme((currentTheme) => (
      currentTheme === 'dark' ? 'light' : 'dark'
    ));
  }

  const nextThemeLabel = isDark ? '일반 모드로 변경' : '다크 모드로 변경';

  return (
    <div className={`theme-toggle-row ${collapsed ? 'collapsed' : ''}`}>
      <span
        className="theme-toggle-icon theme-toggle-sun"
        aria-hidden="true"
      >
        ☀
      </span>

      <button
        type="button"
        className={`theme-toggle-switch ${isDark ? 'is-dark' : ''}`}
        role="switch"
        aria-checked={isDark}
        aria-label={nextThemeLabel}
        title={nextThemeLabel}
        onClick={handleToggle}
      >
        <span className="theme-toggle-thumb" />
      </button>

      <span
        className="theme-toggle-icon theme-toggle-moon"
        aria-hidden="true"
      >
        ☾
      </span>

      {!collapsed && (
        <span className="theme-toggle-label">
          {isDark ? '다크 모드' : '일반 모드'}
        </span>
      )}
    </div>
  );
}
