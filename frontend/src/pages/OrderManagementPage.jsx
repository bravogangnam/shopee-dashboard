import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchOrders, fetchStats } from '../api/orders.js';
import {
  downloadBlob,
  downloadInvoiceJob,
  formatInvoiceJobError,
  getInvoiceJob,
  startInvoiceJob,
} from '../api/invoice.js';
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

const createInitialFilters = () => {
  const params = new URLSearchParams(window.location.search);
  const orderSn = params.get('order_sn') || '';
  const defaults = createDefaultFilters();
  return orderSn
    ? { ...defaults, order_sn: orderSn, date_from: '', date_to: '' }
    : defaults;
};

function toOrderQuery(filters) {
  return {
    ...filters,
    region: filters.region === 'ALL' ? '' : filters.region,
    include_open_backlog: '1',
  };
}

function isInvoiceJobActive(job) {
  const status = String(job?.status || '').toLowerCase();
  return status === 'queued' || status === 'running';
}

function isInvoiceJobDone(job) {
  const status = String(job?.status || '').toLowerCase();
  return status === 'completed' || status === 'partial_failed';
}

function invoiceStatusLabel(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'queued') return '대기 중';
  if (value === 'running') return '송장 생성 중';
  if (value === 'completed') return '송장 생성 완료';
  if (value === 'partial_failed') return '일부 주문 송장 생성 실패';
  if (value === 'failed') return '송장 생성 실패';
  if (value === 'cancelled') return '취소됨';
  return status || '-';
}

export default function OrderManagementPage() {
  const [filters, setFilters] = useState(() => createInitialFilters());
  const [query, setQuery] = useState(() => createInitialFilters());
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState(null);
  const [monthlyStats, setMonthlyStats] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceJob, setInvoiceJob] = useState(null);
  const [invoicePollingError, setInvoicePollingError] = useState('');
  const [syncLoading, setSyncLoading] = useState(false);
  const [feeOrder, setFeeOrder] = useState(null);
  const [previewItem, setPreviewItem] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [invoiceFallbackVisible, setInvoiceFallbackVisible] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const skipStatsOnceRef = useRef(false);
  const invoicePrintWindowRef = useRef(null);
  const autoPrintedInvoiceJobRef = useRef('');
  const invoiceCompleteNotifiedRef = useRef('');
  const skipHideInvoiceFallbackOnceRef = useRef(false);

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
      if (skipHideInvoiceFallbackOnceRef.current) {
        skipHideInvoiceFallbackOnceRef.current = false;
      } else {
        setInvoiceFallbackVisible(false);
      }
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
      if (isInvoiceJobActive(invoiceJob)) return;
      if (selectedOrders.length > 0) return;

      setReloadKey(value => value + 1);
    }, 60000);

    return () => window.clearInterval(intervalId);
  }, [loading, syncLoading, invoiceLoading, invoiceJob, selectedOrders.length]);

  useEffect(() => {
    if (!invoiceJob?.jobId || !isInvoiceJobActive(invoiceJob)) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const result = await getInvoiceJob(invoiceJob.jobId);
        if (!cancelled) {
          setInvoiceJob(result.job || null);
          setInvoicePollingError('');
        }
      } catch (err) {
        if (!cancelled) {
          setInvoicePollingError('작업 상태 확인에 실패했습니다. 서버 작업은 계속 진행 중일 수 있습니다. 잠시 후 새로고침해 주세요.');
        }
      }
    };

    const intervalId = window.setInterval(poll, 2000);
    poll();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [invoiceJob?.jobId, invoiceJob?.status]);

  useEffect(() => {
    if (!invoiceJob?.jobId || !isInvoiceJobDone(invoiceJob) || !invoiceJob.download_url) return;
    if (autoPrintedInvoiceJobRef.current === invoiceJob.jobId) return;

    autoPrintedInvoiceJobRef.current = invoiceJob.jobId;
    autoOpenInvoicePrintWindow(invoiceJob);
  }, [invoiceJob?.jobId, invoiceJob?.status, invoiceJob?.download_url]);

  useEffect(() => {
    const printWindow = invoicePrintWindowRef.current;
    if (!printWindow || printWindow.closed || !invoiceJob) return;
    if (isInvoiceJobDone(invoiceJob) || invoiceJob.download_url) return;

    const percent = Math.min(Number(invoiceJob.percent || 0), 100);
    printWindow.document.open();
    printWindow.document.write(`
      <html>
        <head><title>송장 출력 진행</title></head>
        <body style="font-family: sans-serif; padding: 24px;">
          <h2>${invoiceStatusLabel(invoiceJob.status)}</h2>
          <p>${invoiceJob.message || ''}</p>
          <p>진행 ${invoiceJob.completed || 0}/${invoiceJob.total || 0} (${percent}%)</p>
          <p>실패 ${invoiceJob.failed || 0}건</p>
          ${invoicePollingError ? `<p style="color:#b42318;">${invoicePollingError}</p>` : ''}
        </body>
      </html>
    `);
    printWindow.document.close();
  }, [invoiceJob, invoicePollingError]);

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

  function openInvoicePrintWindow() {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setInvoicePollingError('자동 인쇄창을 열 수 없습니다. 다운로드 버튼을 눌러 송장을 출력하세요.');
      return null;
    }

    printWindow.document.open();
    printWindow.document.write(`
      <html>
        <head><title>송장 준비 중</title></head>
        <body style="font-family: sans-serif; padding: 24px;">
          <h2>송장 준비 중입니다...</h2>
          <p>완료되면 자동으로 인쇄창이 열립니다.</p>
        </body>
      </html>
    `);
    printWindow.document.close();
    return printWindow;
  }

  async function autoOpenInvoicePrintWindow(job) {
    try {
      const blob = await downloadInvoiceJob(job.jobId);
      const url = window.URL.createObjectURL(blob);
      const printWindow = invoicePrintWindowRef.current;

      if (printWindow && !printWindow.closed) {
        const pdfSrc = JSON.stringify(url);
        printWindow.document.open();
        printWindow.document.write(`
          <html>
            <head>
              <title>송장 출력</title>
              <style>
                html, body { margin: 0; width: 100%; height: 100%; }
                iframe { border: 0; width: 100%; height: 100%; }
              </style>
            </head>
            <body>
              <iframe id="invoice-pdf" src=${pdfSrc}></iframe>
              <script>
                const frame = document.getElementById('invoice-pdf');
                frame.onload = function () {
                  setTimeout(function () {
                    try {
                      frame.contentWindow.focus();
                      frame.contentWindow.print();
                    } catch (error) {
                      try { window.print(); } catch (_) {}
                    }
                      try {
                        if (window.opener) {
                          window.opener.postMessage({
                            type: 'INVOICE_PRINT_COMPLETE',
                            successCount: ${Number(job.completed || 0)},
                            failedCount: ${Number(job.failed || 0)}
                          }, '*');
                        }
                      } catch (_) {}
                  }, 700);
                };
              </script>
            </body>
          </html>
        `);
        printWindow.document.close();
        setMessage('송장 PDF가 준비되어 자동 인쇄창을 열었습니다.');
      } else {
        setInvoicePollingError('자동 인쇄창을 열 수 없습니다. 다운로드 버튼을 눌러 송장을 출력하세요.');
        downloadBlob(blob, `invoice-${job.jobId}.pdf`);
      }

      setTimeout(() => window.URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setInvoicePollingError(formatInvoiceJobError(err.message || '자동 인쇄창을 열지 못했습니다. 다운로드 버튼을 눌러 송장을 출력하세요.'));
    }
  }

  async function handleInvoice(orderSnList) {
    if (!orderSnList.length) return;
    setError('');
    setMessage('');
    setInvoicePollingError('');
    setInvoiceFallbackVisible(false);
    skipHideInvoiceFallbackOnceRef.current = false;
    setInvoiceJob(null);
    setInvoiceLoading(true);
    invoicePrintWindowRef.current = openInvoicePrintWindow();
    autoPrintedInvoiceJobRef.current = '';

    try {
      const result = await startInvoiceJob(orderSnList);
      setInvoiceJob(result.job || {
        jobId: result.jobId || result.job_id,
        status: 'queued',
        total: orderSnList.length,
        completed: 0,
        failed: 0,
        message: '송장 생성 작업을 시작했습니다.',
        errors: [],
      });
      setMessage('송장 생성 중입니다. 새 창에서 진행 상황을 확인하세요.');
    } catch (err) {
      if (err.code === 'ALREADY_RUNNING' && (err.job || err.jobId)) {
        setInvoiceJob(err.job || {
          jobId: err.jobId,
          status: 'running',
          message: '이미 송장 생성 작업이 진행 중입니다.',
          errors: [],
        });
        setMessage('이미 송장 생성 작업이 진행 중입니다. 현재 작업 상태를 확인하세요.');
      } else {
        setError(formatInvoiceJobError(err.message || '송장 출력에 실패했습니다.'));
      }
    } finally {
      setInvoiceLoading(false);
    }
  }

  async function handleInvoiceDownload() {
    if (!invoiceJob?.jobId) return;
    setError('');
    setMessage('');
    setInvoiceLoading(true);
    try {
      const blob = await downloadInvoiceJob(invoiceJob.jobId);
      downloadBlob(blob, `invoice-${invoiceJob.jobId}.pdf`);
      setMessage('송장 PDF를 열었습니다.');
    } catch (err) {
      setError(formatInvoiceJobError(err.message || '송장 PDF 다운로드에 실패했습니다.'));
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

  useEffect(() => {
    const onMessage = event => {
      if (event?.data?.type !== 'INVOICE_PRINT_COMPLETE') return;
      if (invoiceCompleteNotifiedRef.current === invoiceJob?.jobId) return;

      invoiceCompleteNotifiedRef.current = invoiceJob?.jobId || 'done';
      setMessage(`송장 출력이 완료되었습니다. 성공 ${event.data.successCount || 0}건, 실패 ${event.data.failedCount || 0}건`);
      setInvoiceFallbackVisible(true);
      skipHideInvoiceFallbackOnceRef.current = true;
      setReloadKey(value => value + 1);
      setSelectedOrders([]);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [invoiceJob?.jobId]);

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
            disabled={!selectedOrders.length || invoiceLoading || isInvoiceJobActive(invoiceJob)}
          >
            {invoiceLoading || isInvoiceJobActive(invoiceJob) ? '송장 생성 중...' : `송장출력 (${selectedOrders.length})`}
          </button>
          <button type="button" className="action-btn" onClick={handleSync} disabled={syncLoading}>
            {syncLoading ? '동기화 중' : '동기화'}
          </button>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="alert">{error}</div>}
      {invoicePollingError && <div className="notice">{invoicePollingError}</div>}
      {invoiceFallbackVisible && isInvoiceJobDone(invoiceJob) && invoiceJob?.download_url && (!invoicePrintWindowRef.current || invoicePrintWindowRef.current.closed) && (
        <div className="notice">
          <span>송장 생성이 완료되었습니다. 새 창이 닫혀 있으면 다운로드 버튼으로 출력하세요.</span>
          <button
            type="button"
            className="action-btn primary"
            onClick={handleInvoiceDownload}
            disabled={invoiceLoading}
            style={{ marginLeft: 12 }}
          >
            다운로드
          </button>
        </div>
      )}

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
