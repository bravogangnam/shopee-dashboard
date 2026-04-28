import { useEffect, useMemo, useState } from 'react';
import { fetchOrders } from '../api/orders.js';
import OrderFilters from '../components/OrderFilters.jsx';
import OrderTable from '../components/OrderTable.jsx';
import Pagination from '../components/Pagination.jsx';

const DEFAULT_FILTERS = {
  page: 1,
  page_size: '20',
  shop_id: '',
  region: '',
  order_status: '',
  date_from: '',
  date_to: '',
  order_sn: '',
};

export default function OrdersPage() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [query, setQuery] = useState(DEFAULT_FILTERS);
  const [orders, setOrders] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  useEffect(() => {
    let cancelled = false;

    async function loadOrders() {
      setLoading(true);
      setError('');
      try {
        const result = await fetchOrders(query);
        if (!cancelled) {
          setOrders(result.data || []);
          setPagination(result.pagination || null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || '주문을 불러오지 못했습니다.');
          setOrders([]);
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
  }, [queryKey]);

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
    <section className="page">
      <div className="page-header">
        <div>
          <h1>주문 목록</h1>
          <p>주문 상태, 판매가, 정산금액, 원가와 마진을 함께 확인합니다.</p>
        </div>
        <button type="button" className="ghost-button" onClick={() => setQuery(current => ({ ...current }))}>
          새로고침
        </button>
      </div>

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
  );
}
