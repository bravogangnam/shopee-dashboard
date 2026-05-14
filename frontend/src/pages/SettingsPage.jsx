import { useEffect, useMemo, useState } from 'react';
import {
  addRate,
  deleteRate,
  fetchAccount,
  fetchRates,
  fetchShops,
  fetchTokenStatus,
  getJobStatus,
  getShopeeAuthUrl,
  refreshToken,
  saveAccount,
  saveRates,
  startBackfill,
  testConnection,
  updateShop,
  fetchGoogleSheetSettings,
  updateGoogleSheetSettings,
  testMarginChartSheet,
  syncMarginChartSheet,
} from '../api/settings.js';
import { formatDateTime } from '../utils/format.js';
import { useAuth } from '../auth/AuthContext.jsx';

const DEFAULT_ACCOUNT = {
  partner_id: '',
  partner_key: '',
  main_account_id: '',
  merchant_id: '',
};

const DEFAULT_CURRENCIES = new Set(['SGD', 'MYR', 'TWD']);

function regionClass(region) {
  return `region-badge region-${String(region || '').toLowerCase()}`;
}

function tokenBadgeClass(status) {
  return `token-badge ${status || 'none'}`;
}

function getShopId(shop) {
  return shop.shop_id || shop.shopId || shop.id || '';
}

function getConnectionRows(result) {
  if (!result) return [];
  const rows = result.results || result.data || result.shops || [];
  return Array.isArray(rows) ? rows : [];
}

function getJobPayload(result) {
  return result.job || result.data || result;
}


function GoogleSheetSettingsSection() {
  const [googleSheetId, setGoogleSheetId] = useState('');
  const [sheetNames, setSheetNames] = useState({
    chart: '차트',
    receipts: '입고관리',
    skuCompositions: '상품구성표',
  });
  const [timestamps, setTimestamps] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingChart, setTestingChart] = useState(false);
  const [syncingChart, setSyncingChart] = useState(false);
  const [chartResult, setChartResult] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadGoogleSheetSettings() {
      setLoading(true);
      setError('');

      try {
        const result = await fetchGoogleSheetSettings();
        const settings = result.settings || {};
        if (!cancelled) {
          setGoogleSheetId(settings.google_sheet_id || '');
          setSheetNames(settings.sheet_names || {
            chart: '차트',
            receipts: '입고관리',
            skuCompositions: '상품구성표',
          });
          setTimestamps({
            last_chart_synced_at: settings.last_chart_synced_at,
            last_receipt_synced_at: settings.last_receipt_synced_at,
            last_composition_synced_at: settings.last_composition_synced_at,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Google Sheet 설정을 불러오지 못했습니다.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadGoogleSheetSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage('');
    setError('');

    try {
      const result = await updateGoogleSheetSettings({
        google_sheet_id: googleSheetId.trim(),
      });
      setGoogleSheetId(result.settings?.google_sheet_id || googleSheetId.trim());
      setMessage('Google Sheet ID가 저장되었습니다.');
    } catch (err) {
      setError(err.message || 'Google Sheet ID 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestChartSheet() {
    setTestingChart(true);
    setMessage('');
    setError('');
    setChartResult(null);

    try {
      const response = await testMarginChartSheet();
      setChartResult(response.result || null);
      setMessage('차트 탭 읽기 테스트가 완료되었습니다.');
    } catch (err) {
      setError(err.message || '차트 탭 읽기 테스트에 실패했습니다.');
    } finally {
      setTestingChart(false);
    }
  }

  async function handleSyncChartSheet() {
    const confirmed = window.confirm('차트 탭 데이터를 현재 tenant의 마진차트 데이터로 동기화할까요?');
    if (!confirmed) return;

    setSyncingChart(true);
    setMessage('');
    setError('');
    setChartResult(null);

    try {
      const response = await syncMarginChartSheet();
      setChartResult(response.result || null);
      setMessage('마진차트 동기화가 완료되었습니다.');
    } catch (err) {
      setError(err.message || '마진차트 동기화에 실패했습니다.');
    } finally {
      setSyncingChart(false);
    }
  }


  return (
    <section className="settings-section google-sheet-settings-section">
      <h2>Google Sheet 연결</h2>
      <p className="settings-help-text">
        제공된 템플릿을 복사해서 사용하세요. 시트명과 컬럼 위치는 변경하면 안 됩니다.
      </p>

      <div className="settings-grid">
        <label className="settings-field google-sheet-id-field">
          <span>Google Sheet ID</span>
          <input
            value={googleSheetId}
            onChange={(event) => setGoogleSheetId(event.target.value)}
            placeholder="Google Sheet URL 또는 ID"
            disabled={loading}
          />
        </label>
      </div>

      <div className="fixed-sheet-names">
        <strong>고정 시트명</strong>
        <span>차트: {sheetNames.chart}</span>
        <span>입고관리: {sheetNames.receipts}</span>
        <span>상품구성표: {sheetNames.skuCompositions}</span>
      </div>

      <div className="google-sheet-sync-status">
        <span>차트 동기화: {timestamps.last_chart_synced_at || '-'}</span>
        <span>입고관리 동기화: {timestamps.last_receipt_synced_at || '-'}</span>
        <span>상품구성표 동기화: {timestamps.last_composition_synced_at || '-'}</span>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="success-text">{message}</p> : null}

      <button
        type="button"
        className="btn btn-primary"
        onClick={handleSave}
        disabled={loading || saving}
      >
        {saving ? '저장 중...' : 'Google Sheet ID 저장'}
      </button>

      <div className="google-sheet-action-row">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleTestChartSheet}
          disabled={loading || testingChart || !googleSheetId.trim()}
        >
          {testingChart ? '테스트 중...' : '차트 읽기 테스트'}
        </button>

        <button
          type="button"
          className="btn btn-purple"
          onClick={handleSyncChartSheet}
          disabled={loading || syncingChart || !googleSheetId.trim()}
        >
          {syncingChart ? '동기화 중...' : '마진차트 동기화'}
        </button>
      </div>

      {chartResult ? (
        <div className="margin-chart-sync-result">
          <strong>차트 결과</strong>
          <span>전체 행: {chartResult.total_rows ?? '-'}</span>
          <span>파싱 성공: {chartResult.parsed_count ?? chartResult.upserted ?? '-'}</span>
          <span>스킵: {chartResult.skipped_count ?? '-'}</span>
          {'upserted' in chartResult ? <span>저장/갱신: {chartResult.upserted}</span> : null}
          {'deactivated' in chartResult ? <span>비활성: {chartResult.deactivated}</span> : null}
          {chartResult.errors?.length ? (
            <small>오류: {chartResult.errors.map((item) => `row ${item.row}: ${item.reason}`).join(' / ')}</small>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}


export default function SettingsPage() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.is_platform_admin === 1 || user?.is_platform_admin === true || user?.is_platform_admin === '1';
  const [account, setAccount] = useState(DEFAULT_ACCOUNT);
  const [tokenStatus, setTokenStatus] = useState(null);
  const [shops, setShops] = useState([]);
  const [rates, setRates] = useState([]);
  const [loading, setLoading] = useState({
    account: false,
    shops: false,
    rates: false,
    connection: false,
    backfill: false,
    refresh: false,
  });
  const [connectionResults, setConnectionResults] = useState(null);
  const [backfillStatus, setBackfillStatus] = useState(null);
  const [editingShop, setEditingShop] = useState(null);
  const [newCurrency, setNewCurrency] = useState({ currency: '', rate_to_krw: '' });
  const [showPartnerKey, setShowPartnerKey] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const connectionRows = useMemo(() => getConnectionRows(connectionResults), [connectionResults]);

  function setLoadingKey(key, value) {
    setLoading(current => ({ ...current, [key]: value }));
  }

  function showMessage(type, text) {
    setMessage({ type, text });
  }

  async function loadAccount() {
    setLoadingKey('account', true);
    try {
      const result = await fetchAccount();
      setAccount({ ...DEFAULT_ACCOUNT, ...(result.data || result.account || result) });
    } catch (err) {
      showMessage('error', err.message || '계정 정보를 불러오지 못했습니다.');
    } finally {
      setLoadingKey('account', false);
    }
  }

  async function loadTokenStatus() {
    try {
      const result = await fetchTokenStatus();
      setTokenStatus(result);
    } catch (err) {
      setTokenStatus({ token_status: 'none', message: err.message });
    }
  }

  async function loadShops() {
    setLoadingKey('shops', true);
    try {
      const result = await fetchShops();
      setShops(result.data || result.shops || []);
    } catch (err) {
      showMessage('error', err.message || '샵 목록을 불러오지 못했습니다.');
    } finally {
      setLoadingKey('shops', false);
    }
  }

  async function loadRates() {
    setLoadingKey('rates', true);
    try {
      const result = await fetchRates();
      setRates(result.data || result.rates || []);
    } catch (err) {
      showMessage('error', err.message || '환율 목록을 불러오지 못했습니다.');
    } finally {
      setLoadingKey('rates', false);
    }
  }

  useEffect(() => {
    loadAccount();
    loadTokenStatus();
    loadShops();
    loadRates();
  }, []);

  useEffect(() => {
    function handleShopeeMessage(event) {
      if (event.data?.type === 'SHOPEE_AUTH_SUCCESS') {
        showMessage('success', 'Shopee 재인증이 완료되었습니다.');
        loadTokenStatus();
        loadShops();
      }
      if (event.data?.type === 'SHOPEE_AUTH_ERROR') {
        showMessage('error', event.data.error || 'Shopee 재인증에 실패했습니다.');
      }
    }

    window.addEventListener('message', handleShopeeMessage);
    return () => window.removeEventListener('message', handleShopeeMessage);
  }, []);

  async function handleSaveAccount() {
    setLoadingKey('account', true);
    try {
      await saveAccount(account);
      showMessage('success', '계정 정보를 저장했습니다.');
      await loadAccount();
    } catch (err) {
      showMessage('error', err.message || '계정 저장에 실패했습니다.');
    } finally {
      setLoadingKey('account', false);
    }
  }

  async function handleRefreshToken() {
    setLoadingKey('refresh', true);
    try {
      await refreshToken();
      showMessage('success', '토큰 갱신을 요청했습니다.');
      await loadTokenStatus();
    } catch (err) {
      showMessage('error', err.message || '토큰 갱신에 실패했습니다.');
    } finally {
      setLoadingKey('refresh', false);
    }
  }

  async function handleShopeeAuth() {
    try {
      const result = await getShopeeAuthUrl({ purpose: 'connect_main_account' });
      const url = result.url || result.auth_url || result.data?.url;
      if (!url) throw new Error('Shopee 인증 URL이 없습니다.');
      window.open(url, 'shopee-auth', 'width=720,height=720');
    } catch (err) {
      showMessage('error', err.message || 'Shopee 인증 URL을 가져오지 못했습니다.');
    }
  }

  async function handleBackfill() {
    setLoadingKey('backfill', true);
    setBackfillStatus({ status: 'running', progress_message: '백필을 시작합니다.' });
    try {
      const result = await startBackfill();
      const jobId = result.job_id || result.id || result.job?.id;
      if (!jobId) throw new Error('백필 Job ID를 받지 못했습니다.');

      for (let i = 0; i < 120; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const statusResult = await getJobStatus(jobId);
        const job = getJobPayload(statusResult);
        setBackfillStatus(job);
        if (job.status === 'completed') {
          showMessage('success', '백필이 완료되었습니다.');
          return;
        }
        if (job.status === 'failed') {
          throw new Error(job.error_message || '백필이 실패했습니다.');
        }
      }
      throw new Error('백필 상태 확인 시간이 초과되었습니다.');
    } catch (err) {
      showMessage('error', err.message || '백필 실행에 실패했습니다.');
    } finally {
      setLoadingKey('backfill', false);
    }
  }

  async function handleConnectionTest() {
    setLoadingKey('connection', true);
    setConnectionResults(null);
    try {
      const result = await testConnection();
      setConnectionResults(result);
      const rows = getConnectionRows(result);
      const allSuccess = rows.length > 0 && rows.every(row => row.success && !row.error);
      showMessage(allSuccess ? 'success' : 'error', allSuccess ? '샵 모두 연결 성공!' : '샵 연결 실패. 결과를 확인하세요.');
    } catch (err) {
      showMessage('error', err.message || 'API 연결 테스트에 실패했습니다.');
    } finally {
      setLoadingKey('connection', false);
    }
  }

  function startEditShop(shop) {
    setEditingShop({
      shop_id: getShopId(shop),
      alias: shop.alias || '',
      region: shop.region || '',
      is_active: shop.is_active === undefined ? true : Boolean(Number(shop.is_active)),
    });
  }

  async function handleSaveShop() {
    if (!editingShop?.shop_id) return;
    setLoadingKey('shops', true);
    try {
      await updateShop(editingShop.shop_id, {
        alias: editingShop.alias,
        region: editingShop.region,
        is_active: editingShop.is_active,
      });
      setEditingShop(null);
      showMessage('success', '샵 정보를 저장했습니다.');
      await loadShops();
    } catch (err) {
      showMessage('error', err.message || '샵 저장에 실패했습니다.');
    } finally {
      setLoadingKey('shops', false);
    }
  }

  function updateRate(currency, value) {
    setRates(current => current.map(rate => (
      rate.currency === currency ? { ...rate, rate_to_krw: value } : rate
    )));
  }

  async function handleSaveRates() {
    setLoadingKey('rates', true);
    try {
      await saveRates(rates.map(rate => ({
        currency: rate.currency,
        rate_to_krw: Number(rate.rate_to_krw),
      })));
      showMessage('success', '환율을 저장했습니다.');
      await loadRates();
    } catch (err) {
      showMessage('error', err.message || '환율 저장에 실패했습니다.');
    } finally {
      setLoadingKey('rates', false);
    }
  }

  async function handleAddRate() {
    if (!newCurrency.currency || !newCurrency.rate_to_krw) {
      showMessage('error', '통화와 환율을 입력하세요.');
      return;
    }
    setLoadingKey('rates', true);
    try {
      await addRate(newCurrency.currency.toUpperCase(), Number(newCurrency.rate_to_krw));
      setNewCurrency({ currency: '', rate_to_krw: '' });
      showMessage('success', '통화를 추가했습니다.');
      await loadRates();
    } catch (err) {
      showMessage('error', err.message || '통화 추가에 실패했습니다.');
    } finally {
      setLoadingKey('rates', false);
    }
  }

  async function handleDeleteRate(currency) {
    setLoadingKey('rates', true);
    try {
      await deleteRate(currency);
      showMessage('success', `${currency} 환율을 삭제했습니다.`);
      await loadRates();
    } catch (err) {
      showMessage('error', err.message || '환율 삭제에 실패했습니다.');
    } finally {
      setLoadingKey('rates', false);
    }
  }

  return (
    <section className={`page settings-page ${isPlatformAdmin ? 'platform-admin-settings' : 'member-settings'}`}>
      <div className="page-header">
        <div>
          <h1>설정</h1>
          <p>Shopee 계정, 샵, 백필, 연결 테스트, 환율을 관리합니다.</p>
        </div>
      </div>

      {tokenStatus?.token_status === 'expired' && (
        <div className="alert alert-error">
          ⚠ Shopee 토큰이 만료되었습니다. API 호출이 불가능합니다.
          <button type="button" className="btn btn-outline" onClick={handleRefreshToken} disabled={loading.refresh}>
            재갱신
          </button>
        </div>
      )}

      {message.text && (
        <div className={`alert ${message.type === 'success' ? 'alert-success' : 'alert-error'}`}>
          {message.text}
        </div>
      )}

      {!isPlatformAdmin && (
        <section className="settings-section member-shopee-guide">
          <h2>Shopee 연결</h2>
          <ol>
            <li>Shopee 재인증 버튼을 누릅니다.</li>
            <li>Shopee 로그인 후 권한을 승인합니다.</li>
            <li>연결된 샵 목록이 표시되면 연결 완료입니다.</li>
          </ol>
        </section>
      )}

      <GoogleSheetSettingsSection />

      <section className="settings-section">
        <h2>Shopee API 계정</h2>
          {!isPlatformAdmin ? (
            <p className="settings-help-text">
              Main Account ID는 Shopee 인증 후 자동으로 표시됩니다. Merchant ID는 직접 입력하지 않습니다.
            </p>
          ) : null}
        <div className="settings-grid">
          <label className="settings-field platform-admin-only">
            <span>* Partner ID</span>
            <input
              value={account.partner_id || ''}
              onChange={event => setAccount(current => ({ ...current, partner_id: event.target.value }))}
            />
          </label>
          <label className="settings-field platform-admin-only">
            <span>* Partner Key</span>
            <div className="password-field">
              <input
                type={showPartnerKey ? 'text' : 'password'}
                value={account.partner_key || ''}
                onChange={event => setAccount(current => ({ ...current, partner_key: event.target.value }))}
              />
              <button type="button" className="btn btn-outline" onClick={() => setShowPartnerKey(value => !value)}>
                {showPartnerKey ? '숨김' : '보기'}
              </button>
            </div>
          </label>
          <label className="settings-field">
            <span>Main Account ID</span>
            <input
              value={account.main_account_id || ''}
              onChange={event => setAccount(current => ({ ...current, main_account_id: event.target.value }))}
              readOnly={!isPlatformAdmin}
              placeholder={isPlatformAdmin ? '' : 'Shopee 인증 후 자동 표시'}
            />
          </label>
          {isPlatformAdmin ? (
            <label className="settings-field">
            <span>Merchant ID</span>
            <input
              value={account.merchant_id || ''}
              onChange={event => setAccount(current => ({ ...current, merchant_id: event.target.value }))}
            />
          </label>
          ) : null}
        </div>
        <div className="token-status">
          <span className={tokenBadgeClass(tokenStatus?.token_status)}>{tokenStatus?.token_status || 'none'}</span>
          <span>만료: {formatDateTime(tokenStatus?.token_expires_at)}</span>
        </div>
        <div className="settings-actions">
          <button type="button" className="btn btn-outline" onClick={handleRefreshToken} disabled={loading.refresh}>
            토큰 갱신
          </button>
          <button type="button" className="btn btn-purple" onClick={handleShopeeAuth}>
            Shopee 재인증
          </button>
          {isPlatformAdmin ? (
            <button type="button" className="btn btn-primary" onClick={handleSaveAccount} disabled={loading.account}>
            계정 저장
          </button>
          ) : null}
        </div>
      </section>

      <section className="settings-section backfill-section">
        <h2>데이터 백필</h2>
        <p>2026-01-01 ~ 현재까지의 주문 데이터를 수집합니다.</p>
        <button type="button" className="btn btn-primary" onClick={handleBackfill} disabled={loading.backfill}>
          {loading.backfill ? '실행 중...' : '백필 실행'}
        </button>
        {backfillStatus && (
          <div className="backfill-status">
            <strong>{backfillStatus.status}</strong>
            <span>{backfillStatus.progress_message || backfillStatus.message || ''}</span>
            {backfillStatus.percent !== undefined && <span>{backfillStatus.percent}%</span>}
          </div>
        )}
      </section>

      <section className="settings-section platform-admin-test-section">
        <h2>Shopee API 연결 테스트</h2>
        <button type="button" className="btn btn-primary" onClick={handleConnectionTest} disabled={loading.connection}>
          {loading.connection ? '테스트 중...' : '연결 테스트'}
        </button>
        {connectionRows.length > 0 && (
          <table className="connection-table">
            <thead>
              <tr>
                <th>Shop ID</th>
                <th>Alias</th>
                <th>Region</th>
                <th>상태</th>
                <th>응답시간</th>
                <th>주문 수</th>
              </tr>
            </thead>
            <tbody>
              {connectionRows.map(row => (
                <tr key={row.shop_id}>
                  <td>{row.shop_id}</td>
                  <td>{row.alias || '-'}</td>
                  <td><span className={regionClass(row.region)}>{row.region || '-'}</span></td>
                  <td>{row.success && !row.error ? '✅ 성공' : `❌ ${row.error || '실패'}`}</td>
                  <td>{row.elapsed_ms ?? row.response_time_ms ?? '-'}ms</td>
                  <td>{row.order_count ?? row.total_count ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="settings-section">
        <h2>샵 관리 ({shops.length}개)</h2>
        <table className="shop-table">
          <thead>
            <tr>
              <th>Shop ID</th>
              <th>Alias</th>
              <th>Region</th>
              <th>활성</th>
              <th>확인</th>
            </tr>
          </thead>
          <tbody>
            {shops.map(shop => {
              const shopId = getShopId(shop);
              const isEditing = editingShop?.shop_id === shopId;
              return (
                <tr key={shopId}>
                  <td>{shopId}</td>
                  <td>
                    {isEditing ? (
                      <input
                        value={editingShop.alias}
                        onChange={event => setEditingShop(current => ({ ...current, alias: event.target.value }))}
                      />
                    ) : (
                      shop.alias || '-'
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <select
                        value={editingShop.region}
                        onChange={event => setEditingShop(current => ({ ...current, region: event.target.value }))}
                      >
                        <option value="">선택</option>
                        <option value="SG">SG</option>
                        <option value="MY">MY</option>
                        <option value="PH">PH</option>
                        <option value="TW">TW</option>
                      </select>
                    ) : (
                      <span className={regionClass(shop.region)}>{shop.region || '-'}</span>
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <button
                        type="button"
                        className={`toggle-switch ${editingShop.is_active ? 'on' : 'off'}`}
                        onClick={() => setEditingShop(current => ({ ...current, is_active: !current.is_active }))}
                        aria-label="활성 토글"
                      />
                    ) : (
                      <span>{Number(shop.is_active) ? 'ON' : 'OFF'}</span>
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <div className="table-actions">
                        <button type="button" className="btn btn-primary" onClick={handleSaveShop} disabled={loading.shops}>저장</button>
                        <button type="button" className="btn btn-outline" onClick={() => setEditingShop(null)}>취소</button>
                      </div>
                    ) : (
                      <button type="button" className="btn btn-outline" onClick={() => startEditShop(shop)}>편집</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!shops.length && (
              <tr>
                <td colSpan="5" className="empty-cell">등록된 샵이 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="settings-section platform-admin-rates-section">
        <h2>환율 관리</h2>
        {rates.map(rate => (
          <div className="rate-row" key={rate.currency}>
            <span className="currency-badge">{rate.currency}</span>
            <input
              type="number"
              step="0.01"
              value={rate.rate_to_krw ?? ''}
              onChange={event => updateRate(rate.currency, event.target.value)}
            />
            <button
              type="button"
              className="rate-delete-btn"
              onClick={() => handleDeleteRate(rate.currency)}
              disabled={DEFAULT_CURRENCIES.has(String(rate.currency).toUpperCase())}
              title="삭제"
            >
              ✕
            </button>
            <small>업데이트: {formatDateTime(rate.updated_at)}</small>
          </div>
        ))}
        <div className="rate-add-row">
          <input
            placeholder="Currency"
            value={newCurrency.currency}
            onChange={event => setNewCurrency(current => ({ ...current, currency: event.target.value.toUpperCase() }))}
          />
          <input
            type="number"
            step="0.01"
            placeholder="rate_to_krw"
            value={newCurrency.rate_to_krw}
            onChange={event => setNewCurrency(current => ({ ...current, rate_to_krw: event.target.value }))}
          />
          <button type="button" className="btn btn-outline" onClick={handleAddRate} disabled={loading.rates}>
            추가
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSaveRates} disabled={loading.rates}>
            저장
          </button>
        </div>
        <p className="rate-note">* 환율 수정 후 [저장] 버튼을 클릭하세요.</p>
      </section>
    </section>
  );
}
