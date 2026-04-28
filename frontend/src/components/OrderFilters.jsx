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
  function setField(field, value) {
    onChange({ ...filters, [field]: value });
  }

  return (
    <form className="filters" onSubmit={onSubmit}>
      <label>
        주문번호
        <input
          value={filters.order_sn}
          onChange={event => setField('order_sn', event.target.value)}
          placeholder="Order SN"
        />
      </label>
      <label>
        국가
        <select value={filters.region} onChange={event => setField('region', event.target.value)}>
          {REGION_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        상태
        <select value={filters.order_status} onChange={event => setField('order_status', event.target.value)}>
          {STATUS_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        시작일
        <input type="date" value={filters.date_from} onChange={event => setField('date_from', event.target.value)} />
      </label>
      <label>
        종료일
        <input type="date" value={filters.date_to} onChange={event => setField('date_to', event.target.value)} />
      </label>
      <div className="filter-actions">
        <button type="submit">검색</button>
        <button type="button" className="ghost-button" onClick={onReset}>초기화</button>
      </div>
    </form>
  );
}
