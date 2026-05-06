import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

function formatKrw(value) {
  const number = Number(value || 0);
  return `₩${number.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}`;
}

function formatCompactKrw(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 10000) {
    return `₩${Math.round(number / 10000).toLocaleString('ko-KR')}만`;
  }
  return `₩${number.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}`;
}

function formatNumber(value, digits = 0) {
  const number = Number(value || 0);
  return number.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function ChartSummaryMetrics({ summary }) {
  const metrics = [
    { label: '매출', value: formatKrw(summary?.total_sales_krw) },
    { label: '정산액', value: formatKrw(summary?.total_escrow_krw) },
    { label: '순이익', value: formatKrw(summary?.total_net_profit) },
    { label: '부가세', value: formatKrw(summary?.total_vat) },
    { label: '순이익률', value: summary ? `${formatNumber(summary.profit_rate, 2)}%` : '-' },
    { label: '주문건수', value: summary ? `${formatNumber(summary.order_count)}건` : '-' },
  ];

  return (
    <div className="chart-summary-metrics">
      {metrics.map(metric => (
        <div className="chart-summary-pill" key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
        </div>
      ))}
    </div>
  );
}

function DailySalesTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  const item = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <strong>{item.date || label}</strong>
      <span>매출 {formatKrw(item.sales_krw)}</span>
      <span>주문수 {item.order_count}건</span>
    </div>
  );
}

export default function DailySalesChart({ data = [], summary = null, loading = false, month = '', onMonthChange }) {
  return (
    <section className="chart-card">
      <div className="chart-header">
        <div>
          <h2>일별 매출 추이</h2>
          <p>DB에 저장된 주문 기준 월별 일 매출입니다.</p>
        </div>
        <div className="chart-actions">
          <input
            type="month"
            className="chart-month-input"
            value={month}
            onChange={event => onMonthChange?.(event.target.value)}
            aria-label="차트 월 선택"
          />
          {loading && <span className="chart-loading">불러오는 중</span>}
        </div>
      </div>

      <ChartSummaryMetrics summary={summary} />

      <div className="chart-body">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ top: 12, right: 18, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="#edf1f5" vertical={false} />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={{ stroke: '#d8dee8' }}
              tickFormatter={day => `${day}일`}
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={formatCompactKrw}
              domain={[0, 'auto']}
              allowDecimals={false}
              tickLine={false}
              axisLine={{ stroke: '#d8dee8' }}
              width={72}
            />
            <Tooltip content={<DailySalesTooltip />} />
            <Line
              type="monotone"
              dataKey="sales_krw"
              stroke="#1677ff"
              strokeWidth={2.5}
              dot={{ r: 2.5, strokeWidth: 1 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
