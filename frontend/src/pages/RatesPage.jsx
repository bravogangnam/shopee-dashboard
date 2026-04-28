import { useEffect, useState } from 'react';
import { fetchRates } from '../api/settings.js';
import { formatDateTime, formatNumber } from '../utils/format.js';

export default function RatesPage() {
  const [rates, setRates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadRates() {
      setLoading(true);
      setError('');
      try {
        const result = await fetchRates();
        if (!cancelled) setRates(result.data || []);
      } catch (err) {
        if (!cancelled) setError(err.message || '환율을 불러오지 못했습니다.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadRates();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1>환율 설정</h1>
          <p>현재 저장된 통화별 KRW 환율을 확인합니다.</p>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {loading ? (
        <div className="table-state">환율을 불러오는 중...</div>
      ) : (
        <div className="table-wrap compact-table">
          <table className="data-table">
            <thead>
              <tr>
                <th>통화</th>
                <th className="num">KRW 환율</th>
                <th>업데이트</th>
              </tr>
            </thead>
            <tbody>
              {rates.map(rate => (
                <tr key={rate.currency}>
                  <td><strong>{rate.currency}</strong></td>
                  <td className="num">{formatNumber(rate.rate_to_krw, 2)}</td>
                  <td>{formatDateTime(rate.updated_at)}</td>
                </tr>
              ))}
              {!rates.length && (
                <tr>
                  <td colSpan="3" className="empty-cell">등록된 환율이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
