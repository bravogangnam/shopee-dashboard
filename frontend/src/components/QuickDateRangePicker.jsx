import { useEffect, useMemo, useRef, useState } from 'react';

function pad(value) {
  return String(value).padStart(2, '0');
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function toDateString(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function getRangeForPreset(year, preset) {
  if (preset.type === 'month') {
    return {
      date_from: toDateString(year, preset.month, 1),
      date_to: toDateString(year, preset.month, daysInMonth(year, preset.month)),
    };
  }

  if (preset.type === 'quarter') {
    const startMonth = (preset.quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      date_from: toDateString(year, startMonth, 1),
      date_to: toDateString(year, endMonth, daysInMonth(year, endMonth)),
    };
  }

  if (preset.type === 'half') {
    const startMonth = preset.half === 1 ? 1 : 7;
    const endMonth = preset.half === 1 ? 6 : 12;
    return {
      date_from: toDateString(year, startMonth, 1),
      date_to: toDateString(year, endMonth, daysInMonth(year, endMonth)),
    };
  }

  return {
    date_from: toDateString(year, 1, 1),
    date_to: toDateString(year, 12, 31),
  };
}

function getYearFromRange(dateFrom, dateTo) {
  const candidate = dateFrom || dateTo;
  const year = Number(String(candidate || '').slice(0, 4));
  return Number.isFinite(year) && year > 1900 ? year : new Date().getFullYear();
}

export default function QuickDateRangePicker({ dateFrom, dateTo, onSelect }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => getYearFromRange(dateFrom, dateTo));
  const rootRef = useRef(null);

  useEffect(() => {
    setYear(getYearFromRange(dateFrom, dateTo));
  }, [dateFrom, dateTo]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const currentRangeKey = `${dateFrom || ''}|${dateTo || ''}`;
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, index) => ({
      type: 'month',
      month: index + 1,
      label: `${index + 1}월`,
    })),
    []
  );

  const quarters = [
    { type: 'quarter', quarter: 1, label: '1분기' },
    { type: 'quarter', quarter: 2, label: '2분기' },
    { type: 'quarter', quarter: 3, label: '3분기' },
    { type: 'quarter', quarter: 4, label: '4분기' },
  ];

  const halves = [
    { type: 'half', half: 1, label: '상반기' },
    { type: 'half', half: 2, label: '하반기' },
    { type: 'year', label: `${year}년 전체` },
  ];

  function selectPreset(preset) {
    onSelect?.(getRangeForPreset(year, preset));
    setOpen(false);
  }

  function isActive(preset) {
    const range = getRangeForPreset(year, preset);
    return `${range.date_from}|${range.date_to}` === currentRangeKey;
  }

  return (
    <div className="quick-date-range" ref={rootRef}>
      <button
        type="button"
        className={`quick-date-trigger ${open ? 'active' : ''}`}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        빠른 기간 ▾
      </button>

      {open && (
        <div className="quick-date-popover">
          <div className="quick-date-header">
            <strong>빠른 기간</strong>
            <div className="quick-date-year">
              <button type="button" onClick={() => setYear(value => value - 1)} aria-label="이전 연도">‹</button>
              <span>{year}</span>
              <button type="button" onClick={() => setYear(value => value + 1)} aria-label="다음 연도">›</button>
            </div>
          </div>

          <section className="quick-date-section">
            <span>월별</span>
            <div className="quick-date-grid quick-date-month-grid">
              {months.map(month => (
                <button
                  type="button"
                  className={isActive(month) ? 'active' : ''}
                  key={month.month}
                  onClick={() => selectPreset(month)}
                >
                  {month.label}
                </button>
              ))}
            </div>
          </section>

          <section className="quick-date-section">
            <span>분기</span>
            <div className="quick-date-grid quick-date-quarter-grid">
              {quarters.map(quarter => (
                <button
                  type="button"
                  className={isActive(quarter) ? 'active' : ''}
                  key={quarter.quarter}
                  onClick={() => selectPreset(quarter)}
                >
                  {quarter.label}
                </button>
              ))}
            </div>
          </section>

          <section className="quick-date-section">
            <span>반기 / 연도</span>
            <div className="quick-date-grid quick-date-half-grid">
              {halves.map(item => (
                <button
                  type="button"
                  className={isActive(item) ? 'active' : ''}
                  key={`${item.type}-${item.half || year}`}
                  onClick={() => selectPreset(item)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
