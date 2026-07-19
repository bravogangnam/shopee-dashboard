import {
  CartesianGrid,
  Line,
  LineChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import dayjs from 'dayjs';

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
    { label: '제품 순이익률', value: summary ? `${formatNumber(summary.product_profit_rate, 2)}%` : '-' },
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
      <span>{item.selected_month_label} 매출 {formatKrw(item.sales_krw)}</span>
      <span>{item.selected_month_label} 주문수 {item.order_count}건</span>
      {item.show_current_month && <span>이번 달 매출 {formatKrw(item.current_month_sales_krw)}</span>}
      {item.show_current_month && <span>이번 달 주문수 {item.current_month_order_count}건</span>}
    </div>
  );
}

export default function DailySalesChart({
  data = [],
  currentMonthData = [],
  summary = null,
  loading = false,
  month = '',
  onMonthChange,
}) {
  const currentMonth = dayjs().format('YYYY-MM');
  const showCurrentMonth = month !== currentMonth;
  const chartData = Array.from({ length: Math.max(data.length, currentMonthData.length) }, (_, index) => {
    const selected = data[index] || {};
    const current = currentMonthData[index] || {};
    const day = index + 1;

    return {
      date: selected.date || `${month}-${String(day).padStart(2, '0')}`,
      day,
      sales_krw: Number(selected.sales_krw || 0),
      order_count: Number(selected.order_count || 0),
      current_month_sales_krw: Number(current.sales_krw || 0),
      current_month_order_count: Number(current.order_count || 0),
      selected_month_label: month,
      show_current_month: showCurrentMonth,
    };
  });

  return (
    <section className="chart-card">
      <div className="chart-header">
        <div>
          <h2>일별 매출 추이</h2>
          <p>선택 월과 이번 달의 일별 매출을 함께 확인합니다.</p>
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
          <LineChart data={chartData} margin={{ top: 12, right: 18, bottom: 4, left: 8 }}>
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
            {showCurrentMonth && <Legend verticalAlign="top" height={28} />}
            <Line
              type="monotone"
              dataKey="sales_krw"
              name={`${month} 매출`}
              stroke="#1677ff"
              strokeWidth={2.5}
              dot={{ r: 2.5, strokeWidth: 1 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
            {showCurrentMonth && (
              <Line
                type="monotone"
                dataKey="current_month_sales_krw"
                name="이번 달 매출"
                stroke="#ff7a45"
                strokeWidth={2.5}
                dot={{ r: 2.5, strokeWidth: 1 }}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
