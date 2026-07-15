import { useEffect, useMemo, useState } from 'react';
import { ConfigProvider } from 'antd';
import koKR from 'antd/locale/ko_KR';
import dayjs from 'dayjs';
import 'antd/dist/reset.css';
import { fetchDailySales, fetchOrders, fetchSummary } from '../api/orders.js';
import DailySalesChart from '../components/DailySalesChart.jsx';
import OrderFilters from '../components/OrderFilters.jsx';
import OrderSettlementDetailModal from '../components/OrderSettlementDetailModal.jsx';
import OrderTable from '../components/OrderTable.jsx';
import Pagination from '../components/Pagination.jsx';
import { formatKrw, formatNumber } from '../utils/format.js';

const getCurrentMonthRange = () => ({
  date_from: dayjs().startOf('month').format('YYYY-MM-DD'),
  date_to: dayjs().format('YYYY-MM-DD'),
});

const createDefaultFilters = () => ({
  page: 1,
  page_size: '100',
  region: '',
  order_status: '',
  order_sn: '',
  max_profit_rate: '',
  ...getCurrentMonthRange(),
});

function getChartMonthRange(month) {
  const base = dayjs(`${month}-01`);
  return {
    date_from: base.startOf('month').format('YYYY-MM-DD'),
    date_to: base.endOf('month').format('YYYY-MM-DD'),
  };
}


const ledgerPageCache = {
  filters: null,
  query: null,
  orders: [],
  summary: null,
  dailySales: [],
  chartSummary: null,
  chartMonth: null,
  pagination: null,
  settlementFilter: 'all',
  ordersKey: null,
  chartKey: null,
  ordersLoaded: false,
  chartLoaded: false,
};

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
    { label: '확정 정산액', value: formatKrw(summary?.total_escrow_krw), changeRate: summary?.escrow_change_rate },
    { label: '확정 순이익', value: formatKrw(summary?.total_net_profit), changeRate: summary?.profit_change_rate },
    { label: '부가세', value: formatKrw(summary?.total_vat), changeRate: summary?.vat_change_rate },
    { label: '확정 순이익률', value: summary ? `${formatNumber(summary.profit_rate, 2)}%` : '-', changeRate: summary?.profit_rate_change_rate },
    { label: '확정 제품 순이익률', value: summary ? `${formatNumber(summary.product_profit_rate, 2)}%` : '-', changeRate: summary?.product_profit_rate_change_rate },
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

export default function LedgerPage() {
  const defaultFilters = useMemo(() => createDefaultFilters(), []);
  const [filters, setFilters] = useState(() => ledgerPageCache.filters || defaultFilters);
  const [query, setQuery] = useState(() => ledgerPageCache.query || defaultFilters);
  const [orders, setOrders] = useState(() => ledgerPageCache.orders || []);
  const [settlementFilter, setSettlementFilter] = useState(() => ledgerPageCache.settlementFilter || 'all');
  const [summary, setSummary] = useState(() => ledgerPageCache.summary || null);
  const [dailySales, setDailySales] = useState(() => ledgerPageCache.dailySales || []);
  const [chartSummary, setChartSummary] = useState(() => ledgerPageCache.chartSummary || null);
  const [chartMonth, setChartMonth] = useState(() => ledgerPageCache.chartMonth || dayjs().subtract(1, 'month').format('YYYY-MM'));
  const [pagination, setPagination] = useState(() => ledgerPageCache.pagination || null);
  const [loading, setLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [detailOrder, setDetailOrder] = useState(null);

  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  useEffect(() => {
    ledgerPageCache.filters = filters;
  }, [filters]);

  useEffect(() => {
    ledgerPageCache.query = query;
  }, [query]);

  useEffect(() => {
    ledgerPageCache.settlementFilter = settlementFilter;
  }, [settlementFilter]);

  useEffect(() => {
    ledgerPageCache.chartMonth = chartMonth;
  }, [chartMonth]);

  useEffect(() => {
    if (reloadKey === 0 && ledgerPageCache.ordersLoaded && ledgerPageCache.ordersKey === queryKey) {
      return;
    }

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
          const nextOrders = ordersResult.data || [];
          const nextPagination = ordersResult.pagination || null;

          setOrders(nextOrders);
          setPagination(nextPagination);
          setSummary(summaryResult);

          ledgerPageCache.ordersLoaded = true;
          ledgerPageCache.ordersKey = queryKey;
          ledgerPageCache.orders = nextOrders;
          ledgerPageCache.pagination = nextPagination;
          ledgerPageCache.summary = summaryResult;
          ledgerPageCache.query = query;
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

  useEffect(() => {
    if (reloadKey === 0 && ledgerPageCache.chartLoaded && ledgerPageCache.chartKey === chartMonth) {
      return;
    }

    let chartCancelled = false;

    async function loadDailySales() {
      setChartLoading(true);
      try {
        const chartRange = getChartMonthRange(chartMonth);
        const [dailySalesResult, chartSummaryResult] = await Promise.all([
          fetchDailySales(chartMonth),
          fetchSummary(chartRange),
        ]);

        if (!chartCancelled) {
          const nextDailySales = dailySalesResult.data || [];
          const nextChartSummary = chartSummaryResult || null;

          setDailySales(nextDailySales);
          setChartSummary(nextChartSummary);

          ledgerPageCache.chartLoaded = true;
          ledgerPageCache.chartKey = chartMonth;
          ledgerPageCache.dailySales = nextDailySales;
          ledgerPageCache.chartSummary = nextChartSummary;
          ledgerPageCache.chartMonth = chartMonth;
        }
      } catch (err) {
        if (!chartCancelled) {
          setDailySales([]);
          setChartSummary(null);
          setError(err.message || '일별 매출 차트를 불러오지 못했습니다.');
        }
      } finally {
        if (!chartCancelled) setChartLoading(false);
      }
    }

    loadDailySales();
    return () => {
      chartCancelled = true;
    };
  }, [chartMonth, reloadKey]);

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

  const settlementCounts = orders.reduce(
    (acc, order) => {
      const weight = Number(order?.order_chargeable_weight_gram || 0);
      acc.all += 1;
      if (weight > 0) acc.confirmed += 1;
      else acc.pending += 1;
      return acc;
    },
    { all: 0, pending: 0, confirmed: 0 }
  );

  const filteredOrders = orders.filter((order) => {
    const weight = Number(order?.order_chargeable_weight_gram || 0);
    if (settlementFilter === 'settled') return weight > 0;
    if (settlementFilter === 'unsettled') return weight <= 0;
    return true;
  });

  return (
    <ConfigProvider locale={koKR}>
      <section className="page ledger-page">
        <div className="page-header">
          <div>
            <h1>정산 관리</h1>
            <p>주문별 매출, 원가, 순이익, 마진율과 일별 매출 추이를 확인합니다.</p>
          </div>
          <button type="button" className="ghost-button" onClick={() => setReloadKey(value => value + 1)}>
            새로고침
          </button>
        </div>

        <SummaryCards summary={summary} />
          <DailySalesChart
            data={dailySales}
            summary={chartSummary}
            loading={chartLoading}
            month={chartMonth}
            onMonthChange={setChartMonth}
          />

          <OrderFilters
            filters={filters}
            onChange={setFilters}
            onSubmit={handleSubmit}
            onReset={handleReset}
            settlementFilter={settlementFilter}
            onSettlementFilterChange={setSettlementFilter}
            settlementCounts={settlementCounts}
          />

        {error && <div className="alert">{error}</div>}


          <OrderTable
            orders={filteredOrders}
            loading={loading}
            onOrderDetail={order => setDetailOrder(order)}
          />
        <Pagination pagination={pagination} onPageChange={handlePageChange} />

        {detailOrder && (
          <OrderSettlementDetailModal
            orderSn={detailOrder.order_sn}
            shopId={detailOrder.shop_id}
            onClose={() => setDetailOrder(null)}
          />
        )}
      </section>
    </ConfigProvider>
  );
}
