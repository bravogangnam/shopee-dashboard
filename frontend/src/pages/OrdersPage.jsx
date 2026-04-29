import { useEffect, useMemo, useState } from 'react';
import { ConfigProvider } from 'antd';
import koKR from 'antd/locale/ko_KR';
import dayjs from 'dayjs';
import 'antd/dist/reset.css';
import { fetchOrders, fetchSummary } from '../api/orders.js';
import OrderFilters from '../components/OrderFilters.jsx';
import OrderTable from '../components/OrderTable.jsx';
import Pagination from '../components/Pagination.jsx';
import { formatKrw, formatNumber } from '../utils/format.js';

const getCurrentMonthRange = () => ({
  date_from: dayjs().startOf('month').format('YYYY-MM-DD'),
  date_to: dayjs().endOf('month').format('YYYY-MM-DD'),
});

const createDefaultFilters = () => ({
  page: 1,
  page_size: '100',
  region: '',
  order_status: '',
  order_sn: '',
  ...getCurrentMonthRange(),
});

function ChangeRate({ value }) {
  if (value === null || value === undefined) return null;

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue === 0) return null;

  const direction = numericValue > 0 ? 'positive' : 'negative';
  const arrow = numericValue > 0 ? '▲' : '▼';

  return (
    <span className={`change-rate ${direction}`}>
      전기간 대비 {arrow} {formatNumber(numericValue, 2)}%
    </span>
  );
}

function SummaryCards({ summary }) {
  const cards = [
    { label: '매출', value: formatKrw(summary?.total_sales_krw), changeRate: summary?.sales_change_rate },
    { label: '정산액', value: formatKrw(summary?.total_escrow_krw), changeRate: summary?.escrow_change_rate },
    { label: '순이익', value: formatKrw(summary?.total_net_profit), changeRate: summary?.profit_change_rate },
    { label: '부가세', value: formatKrw(summary?.total_vat), changeRate: summary?.vat_change_rate },
    { label: '순이익률', value: summary ? `${formatNumber(summary.profit_rate, 2)}%` : '-' },
    { label: '주문건수', value: summary ? `${formatNumber(summary.order_count, 0)}건` : '-', changeRate: summary?.count_change_rate },
  ];

  return (
    <div className="summary-cards">
      {cards.map((card, index) => (
        <div className={`summary-card summary-card-${index + 1}`} key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <ChangeRate value={card.changeRate} />
        </div>
      ))}
    </div>
  );
}

export default function OrdersPage() {
  const [filters, setFilters] = useState(() => createDefaultFilters());
  const [query, setQuery] = useState(() => createDefaultFilters());
  const [orders, setOrders] = useState([]);
  const [summary, setSummary] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  useEffect(() => {
    let cancelled = false;

    async function loadOrders() {
      setLoading(true);
      setError('');
      try {
        const [ordersResult, summaryResult] = await Promise.all([
          fetchOrders(query),
          fetchSummary(query),
        ]);

        if (!cancelled) {
          setOrders(ordersResult.data || []);
          setPagination(ordersResult.pagination || null);
          setSummary(summaryResult);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || '주문을 불러오지 못했습니다.');
          setOrders([]);
          setSummary(null);
          setPagination(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadOrders();
    return () => {
      cancelled = true;
    };
  }, [queryKey, reloadKey]);

  function handleSubmit(event) {
    event.preventDefault();
    setQuery({ ...filters, page: 1 });
  }

  function handleReset() {
    const defaultFilters = createDefaultFilters();
    setFilters(defaultFilters);
    setQuery(defaultFilters);
  }

  function handlePageChange(page) {
    setFilters(current => ({ ...current, page }));
    setQuery(current => ({ ...current, page }));
  }

  return (
    <ConfigProvider locale={koKR}>
      <section className="page ledger-page">
        <div className="page-header">
          <div>
            <h1>장부</h1>
            <p>주문별 매출, 원가, 순이익, 마진율을 확인합니다.</p>
          </div>
          <button type="button" className="ghost-button" onClick={() => setReloadKey(value => value + 1)}>
            새로고침
          </button>
        </div>

        <SummaryCards summary={summary} />

        <OrderFilters
          filters={filters}
          onChange={setFilters}
          onSubmit={handleSubmit}
          onReset={handleReset}
        />

        {error && <div className="alert">{error}</div>}

        <OrderTable orders={orders} loading={loading} />
        <Pagination pagination={pagination} onPageChange={handlePageChange} />
      </section>
    </ConfigProvider>
  );
}
