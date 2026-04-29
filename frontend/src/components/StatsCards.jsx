import { formatKrw, formatNumber } from '../utils/format.js';

const REGION_ORDER = ['SG', 'MY', 'PH', 'TW'];

function Growth({ value }) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue) || numericValue === 0) {
    return <span className="stat-growth neutral">전기간 대비 0.00%</span>;
  }

  const tone = numericValue > 0 ? 'positive' : 'negative';
  const arrow = numericValue > 0 ? '▲' : '▼';

  return (
    <span className={`stat-growth ${tone}`}>
      {arrow} {formatNumber(numericValue, 2)}%
    </span>
  );
}

function regionSalesKrw(card) {
  return Number(card?.total_sales || 0) * Number(card?.rate_to_krw || 0);
}

export default function StatsCards({ stats }) {
  const regionCards = Array.isArray(stats?.region_cards) ? stats.region_cards : [];
  const regionMap = new Map(regionCards.map(card => [card.region, card]));
  const escrowKrw = regionCards.reduce((sum, card) => (
    sum + (Number(card.total_escrow || 0) * Number(card.rate_to_krw || 0))
  ), 0);

  const cards = [
    {
      key: 'total',
      label: '총 매출',
      value: formatKrw(stats?.total_krw || 0),
      sub: <Growth value={stats?.total_krw_growth} />,
      className: 'stat-card-total',
    },
    {
      key: 'escrow',
      label: '총 정산액',
      value: formatKrw(escrowKrw),
      sub: <span className="stat-growth neutral">정산 기준</span>,
      className: 'stat-card-escrow',
    },
    ...REGION_ORDER.map(region => {
      const card = regionMap.get(region) || { region, order_count: 0, total_sales: 0, rate_to_krw: 0, growth_pct: 0 };
      return {
        key: region,
        label: region,
        value: formatKrw(regionSalesKrw(card)),
        sub: (
          <>
            <Growth value={card.growth_pct} />
            <span className="stat-count">{formatNumber(card.order_count || 0, 0)}건</span>
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
