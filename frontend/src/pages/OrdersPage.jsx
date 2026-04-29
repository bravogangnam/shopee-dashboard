import { useEffect, useMemo, useState } from 'react';
import { ConfigProvider } from 'antd';
import koKR from 'antd/locale/ko_KR';
import 'antd/dist/reset.css';
import { fetchOrders, fetchSummary } from '../api/orders.js';
import OrderFilters from '../components/OrderFilters.jsx';
import OrderTable from '../components/OrderTable.jsx';
import Pagination from '../components/Pagination.jsx';
import { formatKrw, formatNumber } from '../utils/format.js';

const DEFAULT_FILTERS = {
  page: 1,
  page_size: '100',
  region: '',
  order_status: '',
  date_from: '',
  date_to: '',
  order_sn: '',
};

function SummaryCards({ summary }) {
  const cards = [
    { label: '매출', value: formatKrw(summary?.total_sales_krw) },
    { label: '정산액', value: formatKrw(summary?.total_escrow_krw) },
    { label: '순이익', value: formatKrw(summary?.total_net_profit) },
    { label: '부가세', value: formatKrw(summary?.total_vat) },
    { label: '순이익률', value: summary ? `${formatNumber(summary.profit_rate, 2)}%` : '-' },
  ];

  return (
    <div className="summary-cards">
      {cards.map((card, index) => (
        <div className={`summary-card summary-card-${index + 1}`} key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
        </div>
      ))}
    </div>
  );
}

export default function OrdersPage() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [query, setQuery] = useState(DEFAULT_FILTERS);
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
    setFilters(DEFAULT_FILTERS);
    setQuery(DEFAULT_FILTERS);
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
            <h1>정산목록</h1>
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
