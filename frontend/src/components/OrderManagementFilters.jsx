import { DatePicker } from 'antd';
import dayjs from 'dayjs';

const { RangePicker } = DatePicker;

const REGIONS = ['ALL', 'SG', 'MY', 'PH', 'TW'];

const STATUSES = [
  { value: '', label: '전체' },
  { value: 'UNPAID', label: '결제 대기' },
  { value: 'PENDING', label: '펜딩' },
  { value: 'READY_TO_SHIP', label: '송장준비' },
  { value: 'LABEL_READY', label: '송장출력대기' },
  { value: 'PROCESSED', label: '발송처리' },
  { value: 'SHIPPED', label: '배송 중' },
  { value: 'TO_CONFIRM_RECEIVE', label: '수취 확인' },
  { value: 'COMPLETED', label: '배송 완료' },
  { value: 'IN_CANCEL', label: '취소 요청' },
  { value: 'TO_RETURN', label: '반품/환불' },
  { value: 'CANCELLED', label: '취소 완료' },
];

function getStatusCount(stats, status) {
  if (!status) return stats?.total_order_count || 0;
  const item = stats?.by_status?.find(row => row.order_status === status);
  return item?.count || 0;
}

export default function OrderManagementFilters({ filters, stats, onChange, onSubmit, onReset }) {
  const isAllPeriodStatus = Boolean(filters.order_status);

  const dateRangeValue = filters.date_from && filters.date_to
    ? [dayjs(filters.date_from), dayjs(filters.date_to)]
    : null;

  function setField(field, value) {
    if (field === 'order_status' && value) {
      onChange({
        ...filters,
        order_status: value,
        date_from: '',
        date_to: '',
        page: 1,
      });
      return;
    }

    onChange({
      ...filters,
      [field]: value,
      page: 1,
    });
  }

  function setDateRange(dates) {
    onChange({
      ...filters,
      date_from: dates?.[0] ? dates[0].format('YYYY-MM-DD') : '',
      date_to: dates?.[1] ? dates[1].format('YYYY-MM-DD') : '',
    });
  }

  return (
    <form className="order-management-filters" onSubmit={onSubmit}>
      <div className="region-tabs" role="tablist" aria-label="국가 필터">
        {REGIONS.map(region => (
          <button
            type="button"
            className={`region-tab ${filters.region === region ? 'active' : ''}`}
            onClick={() => setField('region', region)}
            key={region}
          >
            {region}
          </button>
        ))}
      </div>

      <div className="status-tabs" role="tablist" aria-label="상태 필터">
        {STATUSES.map(status => (
          <button
            type="button"
            className={`status-tab ${filters.order_status === status.value ? 'active' : ''}`}
            onClick={() => setField('order_status', status.value)}
            key={status.label}
          >
            {status.label} ({getStatusCount(stats, status.value)})
          </button>
        ))}
      </div>

      <div className="order-filter-row">
        <label className="filter-field date-range-field">
          기간
          {isAllPeriodStatus ? (
            <div className="order-all-period-notice">
              전체 기간 조회
            </div>
          ) : (
            <RangePicker
              allowClear
              format="YYYY-MM-DD"
              value={dateRangeValue}
              onChange={setDateRange}
              placeholder={['시작일', '종료일']}
              style={{ width: 260 }}
            />
          )}
        </label>
        <label className="filter-field order-search-field">
          주문번호
          <input
            value={filters.order_sn}
            onChange={event => setField('order_sn', event.target.value)}
            placeholder="Order SN / SKU / 상품명"
          />
        </label>
        <div className="filter-actions">
          <button type="submit">검색</button>
          <button type="button" className="ghost-button" onClick={onReset}>초기화</button>
        </div>
      </div>
    </form>
  );
}
