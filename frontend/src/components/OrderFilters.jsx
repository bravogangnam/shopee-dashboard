import { DatePicker } from 'antd';
import dayjs from 'dayjs';

const { RangePicker } = DatePicker;

const STATUS_OPTIONS = [
  { value: '', label: '전체 상태' },
  { value: 'UNPAID', label: 'UNPAID' },
  { value: 'READY_TO_SHIP', label: 'READY_TO_SHIP' },
  { value: 'PROCESSED', label: 'PROCESSED' },
  { value: 'SHIPPED', label: 'SHIPPED' },
  { value: 'TO_CONFIRM_RECEIVE', label: 'TO_CONFIRM_RECEIVE' },
  { value: 'COMPLETED', label: 'COMPLETED' },
  { value: 'CANCELLED', label: 'CANCELLED' },
];

const REGION_OPTIONS = [
  { value: '', label: '전체 국가' },
  { value: 'SG', label: 'SG' },
  { value: 'MY', label: 'MY' },
  { value: 'TW', label: 'TW' },
  { value: 'PH', label: 'PH' },
];

export default function OrderFilters({ filters, onChange, onSubmit, onReset }) {
  const dateRangeValue = filters.date_from && filters.date_to
    ? [dayjs(filters.date_from), dayjs(filters.date_to)]
    : null;

  function setField(field, value) {
    onChange({ ...filters, [field]: value });
  }

  function setDateRange(dates) {
    onChange({
      ...filters,
      date_from: dates?.[0] ? dates[0].format('YYYY-MM-DD') : '',
      date_to: dates?.[1] ? dates[1].format('YYYY-MM-DD') : '',
    });
  }

  return (
    <form className="filters" onSubmit={onSubmit}>
      <label className="filter-field order-search-field">
        주문번호
        <input
          value={filters.order_sn}
          onChange={event => setField('order_sn', event.target.value)}
          placeholder="Order SN"
        />
      </label>
      <label className="filter-field">
        국가
        <select value={filters.region} onChange={event => setField('region', event.target.value)}>
          {REGION_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className="filter-field">
        상태
        <select value={filters.order_status} onChange={event => setField('order_status', event.target.value)}>
          {STATUS_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className="filter-field date-range-field">
        기간
        <RangePicker
          allowClear
          format="YYYY-MM-DD"
          value={dateRangeValue}
          onChange={setDateRange}
          placeholder={['시작일', '종료일']}
          style={{ width: 260 }}
        />
      </label>
      <div className="filter-actions">
        <button type="submit">검색</button>
        <button type="button" className="ghost-button" onClick={onReset}>초기화</button>
      </div>
    </form>
  );
}
