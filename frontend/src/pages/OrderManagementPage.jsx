import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchOrders, fetchStats } from '../api/orders.js';
import { createAndDownloadInvoice } from '../api/invoice.js';
import { startSync } from '../api/sync.js';
import FeeDetailModal from '../components/FeeDetailModal.jsx';
import ImagePreviewModal from '../components/ImagePreviewModal.jsx';
import OrderManagementFilters from '../components/OrderManagementFilters.jsx';
import OrderManagementTable from '../components/OrderManagementTable.jsx';
import Pagination from '../components/Pagination.jsx';
import StatsCards from '../components/StatsCards.jsx';

function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

const getCurrentDayRange = () => {
  const today = todayKST();
  return {
    date_from: today,
    date_to: today,
  };
};

const getCurrentMonthStatsRange = () => {
  const today = todayKST();
  return {
    date_from: `${today.slice(0, 8)}01`,
    date_to: today,
  };
};

function formatDateLabel(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return '';
  const format = value => (value ? value.slice(5) : '');
  if (dateFrom && dateTo && dateFrom === dateTo) return format(dateFrom);
  return `${format(dateFrom)}~${format(dateTo)}`;
}

const getMonthlyLabel = () => {
  const range = getCurrentMonthStatsRange();
  return formatDateLabel(range.date_from, range.date_to);
};

const getFilterLabel = filters => formatDateLabel(filters.date_from, filters.date_to);

const getCurrentMonthRange = () => ({
  ...getCurrentDayRange(),
});

const createDefaultFilters = () => ({
  region: 'ALL',
  order_status: '',
  order_sn: '',
  page: 1,
  page_size: 20,
  ...getCurrentMonthRange(),
});

function toOrderQuery(filters) {
  return {
    ...filters,
    region: filters.region === 'ALL' ? '' : filters.region,
  };
}

export default function OrderManagementPage() {
  const [filters, setFilters] = useState(() => createDefaultFilters());
  const [query, setQuery] = useState(() => createDefaultFilters());
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState(null);
  const [monthlyStats, setMonthlyStats] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [feeOrder, setFeeOrder] = useState(null);
  const [previewItem, setPreviewItem] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const skipStatsOnceRef = useRef(false);

  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  async function loadMonthlyStats() {
    try {
      const range = getCurrentMonthStatsRange();
      const result = await fetchStats(range);
      setMonthlyStats(result);
    } catch (err) {
      console.warn('[OrderManagement] Failed to fetch monthly stats:', err);
      setMonthlyStats(null);
    }
  }

  async function loadData(nextQuery, options = { includeStats: true }) {
    setLoading(true);
    setError('');
    try {
      const orderQuery = toOrderQuery(nextQuery);
      const ordersPromise = fetchOrders(orderQuery);
      const statsPromise = options.includeStats
        ? fetchStats(nextQuery)
        : Promise.resolve(null);
      const [ordersResult, statsResult] = await Promise.all([ordersPromise, statsPromise]);

      setOrders(ordersResult.data || []);
      setPagination(ordersResult.pagination || null);
      if (statsResult) setStats(statsResult);
      setSelectedOrders([]);
    } catch (err) {
      setError(err.message || '주문 정보를 불러오지 못했습니다.');
      setOrders([]);
      setPagination(null);
      if (options.includeStats) setStats(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const includeStats = !skipStatsOnceRef.current;
    skipStatsOnceRef.current = false;
    loadData(query, { includeStats });
  }, [queryKey, reloadKey]);

  useEffect(() => {
    loadMonthlyStats();
  }, [reloadKey]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (loading || syncLoading || invoiceLoading) return;
      if (selectedOrders.length > 0) return;

      setReloadKey(value => value + 1);
    }, 60000);

    return () => window.clearInterval(intervalId);
  }, [loading, syncLoading, invoiceLoading, selectedOrders.length]);

  function handleSubmit(event) {
    event.preventDefault();
    setMessage('');
    setQuery({ ...filters, page: 1 });
  }

  function handleReset() {
    const defaultFilters = createDefaultFilters();
    setMessage('');
    setFilters(defaultFilters);
    setQuery(defaultFilters);
  }

  function handlePageChange(page) {
    const nextQuery = { ...query, page };
    setFilters(current => ({ ...current, page }));
    skipStatsOnceRef.current = true;
    setQuery(nextQuery);
  }

  function handleRefresh() {
    setMessage('');
    setReloadKey(value => value + 1);
  }

  async function handleInvoice(orderSnList) {
    if (!orderSnList.length) return;
    setError('');
    setMessage('');
    setInvoiceLoading(true);

    try {
      await createAndDownloadInvoice(orderSnList);
      setMessage(`송장 출력이 완료되었습니다. (${orderSnList.length}건)`);
    } catch (err) {
      setError(err.message || '송장 출력에 실패했습니다.');
    } finally {
      setInvoiceLoading(false);
    }
  }

  async function handleSync() {
    setError('');
    setMessage('');
    setSyncLoading(true);
    try {
      const result = await startSync();
      const serverMessage = result.message || '';
      setMessage(serverMessage.includes('ALREADY_RUNNING')
        ? '동기화가 이미 진행 중입니다.'
        : serverMessage || '동기화를 시작했습니다.');
    } catch (err) {
      const serverMessage = err.message || '';
      setError(serverMessage.includes('ALREADY_RUNNING')
        ? '동기화가 이미 진행 중입니다.'
        : serverMessage || '동기화 시작에 실패했습니다.');
    } finally {
      setSyncLoading(false);
    }
  }

  return (
    <section className="page order-management-page">
      <div className="page-header">
        <div>
          <h1>주문 관리</h1>
          <p>주문 목록, 송장 출력, 동기화 작업을 관리합니다.</p>
        </div>
        <div className="action-buttons">
          <button type="button" className="action-btn" onClick={handleRefresh} disabled={loading}>
            새로고침
          </button>
          <button
            type="button"
            className="action-btn primary"
            onClick={() => handleInvoice(selectedOrders)}
            disabled={!selectedOrders.length || invoiceLoading}
          >
            {invoiceLoading ? '송장 처리중' : `송장출력 (${selectedOrders.length})`}
          </button>
          <button type="button" className="action-btn" onClick={handleSync} disabled={syncLoading}>
            {syncLoading ? '동기화 중' : '동기화'}
          </button>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="alert">{error}</div>}

      <StatsCards
        monthlyStats={monthlyStats}
        filterStats={stats}
        dateFrom={query.date_from}
        dateTo={query.date_to}
        monthlyLabel={getMonthlyLabel()}
        filterLabel={getFilterLabel(query)}
      />

      <OrderManagementFilters
        filters={filters}
        stats={stats}
        onChange={setFilters}
        onSubmit={handleSubmit}
        onReset={handleReset}
      />

      <OrderManagementTable
        orders={orders}
        selectedOrders={selectedOrders}
        onSelectionChange={setSelectedOrders}
        onFeeDetail={order => setFeeOrder(order)}
        onImagePreview={item => setPreviewItem(item)}
        loading={loading}
      />
      <Pagination pagination={pagination} onPageChange={handlePageChange} />

      {feeOrder && (
        <FeeDetailModal order={feeOrder} onClose={() => setFeeOrder(null)} />
      )}
      {previewItem && (
        <ImagePreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />
      )}
    </section>
  );
}
