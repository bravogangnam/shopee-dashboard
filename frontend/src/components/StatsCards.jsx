import { formatNumber } from '../utils/format.js';

const REGION_ORDER = ['SG', 'MY', 'PH', 'TW'];

function pickNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function formatKrwValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return `₩${Math.round(number).toLocaleString('ko-KR')}`;
}

function Growth({ value }) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue) || numericValue === 0) {
    return <span className="stat-growth neutral">0.00%</span>;
  }

  const tone = numericValue > 0 ? 'positive' : 'negative';
  const arrow = numericValue > 0 ? '▲' : '▼';

  return (
    <span className={`stat-growth ${tone}`}>
      {arrow} {formatNumber(numericValue, 2)}%
    </span>
  );
}

function getTotalKrw(stats) {
  return pickNumber(
    stats?.total_krw,
    stats?.total_sales_krw,
    stats?.summary?.total_krw,
    stats?.summary?.total_sales_krw,
  );
}

function getGrowth(stats) {
  return pickNumber(
    stats?.total_krw_growth,
    stats?.sales_change_rate,
    stats?.summary?.total_krw_growth,
    stats?.summary?.sales_change_rate,
  );
}

function getRegionCards(stats) {
  const candidates = [
    stats?.region_cards,
    stats?.regions,
    stats?.by_region,
    stats?.summary?.region_cards,
    stats?.summary?.regions,
    stats?.summary?.by_region,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function regionSalesKrw(card) {
  return pickNumber(card?.total_sales, card?.total_merchandise, card?.sales) *
    pickNumber(card?.rate_to_krw, card?.krw_rate);
}

export default function StatsCards({
  stats,
  monthlyStats,
  filterStats,
  monthlyLabel,
  filterLabel,
}) {
  const currentFilterStats = filterStats || stats || null;
  const currentMonthlyStats = monthlyStats || stats || null;
  const regionCards = getRegionCards(currentFilterStats);
  const regionMap = new Map(regionCards.map(card => [card.region || card.alias || card.currency, card]));

  const cards = [
    {
      key: 'monthly-sales',
      label: '월 매출 (KRW)',
      value: formatKrwValue(getTotalKrw(currentMonthlyStats)),
      sub: (
        <>
          <Growth value={getGrowth(currentMonthlyStats)} />
          {monthlyLabel && <span className="stat-count">{monthlyLabel}</span>}
        </>
      ),
      className: 'stat-card-total',
    },
    {
      key: 'daily-sales',
      label: '일 매출 (KRW)',
      value: formatKrwValue(getTotalKrw(currentFilterStats)),
      sub: (
        <>
          <Growth value={getGrowth(currentFilterStats)} />
          {filterLabel && <span className="stat-count">{filterLabel}</span>}
        </>
      ),
      className: 'stat-card-escrow',
    },
    ...REGION_ORDER.map(region => {
      const card = regionMap.get(region) || { region, order_count: 0, total_sales: 0, rate_to_krw: 0, growth_pct: 0 };
      return {
        key: region,
        label: region,
        value: formatKrwValue(regionSalesKrw(card)),
        sub: (
          <>
            <Growth value={card.growth_pct ?? card.growth_rate ?? card.sales_growth} />
            <span className="stat-count">{formatNumber(card.order_count || card.count || 0, 0)}건</span>
          </>
        ),
        className: `stat-card-${region.toLowerCase()}`,
      };
    }),
  ];

  return (
    <div className="stats-cards-row">
      {cards.map(card => (
        <div className={`stat-card ${card.className}`} key={card.key}>
          <span className="stat-label">{card.label}</span>
          <strong className="stat-value">{card.value}</strong>
          <div className="stat-sub">{card.sub}</div>
        </div>
      ))}
    </div>
  );
}
