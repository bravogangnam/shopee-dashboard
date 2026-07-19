import { formatCurrency, formatDateTime, formatKrw, formatNumber } from '../utils/format.js';

function formatUsd(value) {
  if (value === null || value === undefined) return '-';
  return `$${formatNumber(value, 2)}`;
}

function shopLabel(shop) {
  if (shop.alias && shop.shop_name && shop.alias !== shop.shop_name) {
    return `${shop.alias} · ${shop.shop_name}`;
  }
  return shop.alias || shop.shop_name || `Shop ${shop.shop_id}`;
}

function CurrencyTotals({ totals }) {
  const items = totals?.by_currency || [];
  if (!items.length) return <span className="payout-balance-empty-total">저장된 금액 없음</span>;
  return items.map((item) => (
    <span className="payout-balance-currency-total" key={item.currency}>
      {formatCurrency(item.amount, item.currency)}
    </span>
  ));
}

export default function ShopeePayoutBalancePanel({
  data,
  expanded,
  loading,
  refreshing,
  onToggle,
  onRefresh,
}) {
  const totals = data?.totals || {};
  const shops = data?.shops || [];
  const lastSyncedAt = shops.reduce((latest, shop) => {
    if (!shop.synced_at) return latest;
    return !latest || String(shop.synced_at) > String(latest) ? shop.synced_at : latest;
  }, null);
  const failedCount = shops.filter((shop) => shop.last_error).length;

  return (
    <section className={`payout-balance-panel${expanded ? ' expanded' : ''}`} aria-label="Shopee 지급 가능 금액">
      <div className="payout-balance-summary-row">
        <div className="payout-balance-title-wrap">
          <div className="payout-balance-title-line">
            <span className="payout-balance-icon" aria-hidden="true">$</span>
            <div>
              <h2>Shopee 지급 가능 금액</h2>
              <p>Payment API의 지급 가능한 Balance Amount만 표시합니다.</p>
            </div>
          </div>
          {lastSyncedAt && <span className="payout-balance-updated">최근 조회 {formatDateTime(lastSyncedAt)}</span>}
        </div>

        <div className="payout-balance-totals">
          <div className="payout-balance-local-totals">
            <span>현지 통화 합계</span>
            <div><CurrencyTotals totals={totals} /></div>
          </div>
          <div className="payout-balance-total payout-balance-usd-total">
            <span>USD 합계</span>
            <strong>{formatUsd(totals.usd_amount)}</strong>
          </div>
          <div className="payout-balance-total">
            <span>KRW 합계</span>
            <strong>{formatKrw(totals.krw_amount)}</strong>
          </div>
        </div>

        <div className="payout-balance-actions">
          <button type="button" className="ghost-button" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? '조회 중...' : '새로고침'}
          </button>
          <button type="button" className="payout-balance-toggle" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? '샵별 접기' : '샵별 보기'}
          </button>
        </div>
      </div>

      {loading && <div className="payout-balance-state">저장된 지급 가능 금액을 불러오는 중입니다.</div>}
      {!loading && !totals.conversion_available && totals.missing_rates?.length > 0 && (
        <div className="payout-balance-notice">
          USD/KRW 환산에는 설정의 환율이 필요합니다: {totals.missing_rates.join(', ')}
        </div>
      )}
      {!loading && failedCount > 0 && (
        <div className="payout-balance-notice error">
          {failedCount}개 샵의 이번 조회에 실패했습니다. 마지막 저장 금액을 유지했습니다.
        </div>
      )}

      {expanded && (
        <div className="payout-balance-shop-list">
          {shops.length === 0 && <div className="payout-balance-state">연동된 활성 샵이 없습니다.</div>}
          {shops.map((shop) => (
            <article className="payout-balance-shop" key={shop.shop_id}>
              <div className="payout-balance-shop-heading">
                <div>
                  <span className={`payout-balance-region region-${String(shop.region || 'other').toLowerCase()}`}>
                    {shop.region || shop.currency || 'SHOP'}
                  </span>
                  <strong>{shopLabel(shop)}</strong>
                </div>
                <span className="payout-balance-shop-currency">{shop.currency || '통화 미확인'}</span>
              </div>
              <div className="payout-balance-shop-values">
                <div className="payout-balance-local-value">
                  <span>지급 가능 금액</span>
                  <strong>{formatCurrency(shop.balance_amount, shop.currency)}</strong>
                </div>
                <div className="payout-balance-converted-value">
                  <span>USD</span>
                  <strong>{formatUsd(shop.usd_amount)}</strong>
                </div>
                <div className="payout-balance-converted-value">
                  <span>KRW</span>
                  <strong>{formatKrw(shop.krw_amount)}</strong>
                </div>
              </div>
              {shop.last_error && <p className="payout-balance-shop-error">최근 조회 실패: {shop.last_error}</p>}
              {!shop.last_error && !shop.synced_at && <p className="payout-balance-shop-empty">아직 조회하지 않았습니다.</p>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
