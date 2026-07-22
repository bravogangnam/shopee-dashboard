import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  approveTenant,
  deleteTenant,
  fetchAdminTenants,
  fetchAdminUsers,
  rejectTenant,
  suspendTenant,
} from '../api/admin.js';
import { cleanupServerStorage, fetchServerStorage } from '../api/settings.js';

const STATUS_OPTIONS = [
  { value: '', label: '전체' },
  { value: 'pending', label: '승인 대기' },
  { value: 'approved', label: '승인 완료' },
  { value: 'rejected', label: '거절' },
  { value: 'suspended', label: '정지' },
];

const STATUS_LABELS = {
  pending: '승인 대기',
  approved: '승인 완료',
  rejected: '거절',
  suspended: '정지',
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '-';
}

function formatDate(value) {
  if (!value) return '-';

  try {
    return new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch (_) {
    return String(value);
  }
}

function formatStorageBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

export default function AdminPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [tenants, setTenants] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [serverStorage, setServerStorage] = useState(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageCleanupLoading, setStorageCleanupLoading] = useState(false);

  const tenantStats = useMemo(() => {
    return tenants.reduce(
      (acc, tenant) => {
        const status = tenant.approval_status || 'unknown';
        acc.total += 1;
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      },
      { total: 0, pending: 0, approved: 0, rejected: 0, suspended: 0 }
    );
  }, [tenants]);

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [tenantResult, userResult] = await Promise.all([
        fetchAdminTenants(statusFilter ? { status: statusFilter } : {}),
        fetchAdminUsers(),
      ]);

      setTenants(tenantResult.tenants || []);
      setUsers(userResult.users || []);
    } catch (err) {
      setError(err.message || '관리자 데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  const loadServerStorage = useCallback(async () => {
    setStorageLoading(true);
    try {
      const result = await fetchServerStorage();
      setServerStorage(result.data || null);
    } catch (err) {
      setError(err.message || '서버 용량을 확인하지 못했습니다.');
    } finally {
      setStorageLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  useEffect(() => {
    loadServerStorage();
  }, [loadServerStorage]);

  async function handleServerCleanup() {
    const confirmed = window.confirm(
      '임시 합본 PDF, 45일이 지난 개별 송장, 최신 3개를 제외한 배포 백업, 애플리케이션 로그만 정리합니다. 주문·정산·재고·DB·브랜드 배경 이미지는 삭제하지 않습니다. 계속할까요?'
    );
    if (!confirmed) return;

    setStorageCleanupLoading(true);
    setError('');
    setMessage('');
    try {
      const result = await cleanupServerStorage();
      const data = result.data || {};
      setServerStorage(data.after || null);
      setMessage(`안전 정리 완료: ${formatStorageBytes(data.deletedBytes)}를 정리했습니다.`);
    } catch (err) {
      setError(err.message || '서버 안전 정리에 실패했습니다.');
    } finally {
      setStorageCleanupLoading(false);
    }
  }

  async function runTenantAction(type, tenant) {
    const reasonRequired = type === 'reject' || type === 'suspend';
    let reason = '';

    if (type === 'delete') {
      const confirmationCode = window.prompt(
        `${tenant.code} Tenant와 연결된 주문, 정산, 상품, 재고, 설정 및 사용자 데이터를 모두 영구 삭제합니다.\n\n계속하려면 Tenant 코드 ${tenant.code} 를 정확히 입력하세요.`,
        ''
      );

      if (confirmationCode === null) return;
      if (confirmationCode.trim() !== tenant.code) {
        setError('Tenant 코드가 일치하지 않아 삭제하지 않았습니다.');
        return;
      }

      reason = confirmationCode.trim();
    }

    if (reasonRequired) {
      const label = type === 'reject' ? '거절' : '정지';
      reason = window.prompt(`${tenant.code} ${label} 사유를 입력하세요.`, '') || '';
      reason = reason.trim();

      if (reason.length > 255) {
        setError('사유는 255자 이하로 입력해야 합니다.');
        return;
      }
    }

    const actionKey = `${type}:${tenant.id}`;
    setActionLoading(actionKey);
    setError('');
    setMessage('');

    try {
      if (type === 'approve') {
        await approveTenant(tenant.id);
        setMessage(`${tenant.code} 승인 완료`);
      } else if (type === 'reject') {
        await rejectTenant(tenant.id, reason);
        setMessage(`${tenant.code} 거절 완료`);
      } else if (type === 'suspend') {
        await suspendTenant(tenant.id, reason);
        setMessage(`${tenant.code} 정지 완료`);
      } else if (type === 'delete') {
        await deleteTenant(tenant.id, reason);
        setMessage(`${tenant.code} Tenant와 관련 데이터가 모두 삭제되었습니다.`);
      }

      await loadAdminData();
    } catch (err) {
      setError(err.message || '처리 중 오류가 발생했습니다.');
    } finally {
      setActionLoading('');
    }
  }

  return (
    <section className="page admin-page">
      <div className="page-header">
        <div>
          <h1>관리자</h1>
          <p>Tenant 가입 요청, 승인 상태, 사용자 목록을 관리합니다.</p>
        </div>
        <button className="secondary-button" type="button" onClick={loadAdminData} disabled={loading}>
          새로고침
        </button>
      </div>

      <div className="admin-stats">
        <div className="admin-stat-card">
          <span>전체</span>
          <strong>{tenantStats.total}</strong>
        </div>
        <div className="admin-stat-card pending">
          <span>승인 대기</span>
          <strong>{tenantStats.pending || 0}</strong>
        </div>
        <div className="admin-stat-card approved">
          <span>승인 완료</span>
          <strong>{tenantStats.approved || 0}</strong>
        </div>
        <div className="admin-stat-card rejected">
          <span>거절</span>
          <strong>{tenantStats.rejected || 0}</strong>
        </div>
        <div className="admin-stat-card suspended">
          <span>정지</span>
          <strong>{tenantStats.suspended || 0}</strong>
        </div>
      </div>

      <section className="panel admin-panel server-storage-card">
        <div className="server-storage-heading">
          <div>
            <h2>서버 저장공간</h2>
            <p>서버 용량을 확인하고 다시 만들 수 있는 안전한 파일만 정리합니다.</p>
          </div>
          <button type="button" className="secondary-button" onClick={loadServerStorage} disabled={storageLoading || storageCleanupLoading}>
            {storageLoading ? '확인 중...' : '용량 새로고침'}
          </button>
        </div>

        {serverStorage ? (
          <>
            <div className="server-storage-summary">
              <div><span>전체 용량</span><strong>{formatStorageBytes(serverStorage.volume?.totalBytes)}</strong></div>
              <div><span>사용 중</span><strong>{formatStorageBytes(serverStorage.volume?.usedBytes)}</strong></div>
              <div><span>사용 가능</span><strong>{formatStorageBytes(serverStorage.volume?.availableBytes)}</strong></div>
              <div><span>정리 가능</span><strong className="cleanup-amount">{formatStorageBytes(serverStorage.cleanup?.reclaimableBytes)}</strong></div>
            </div>
            <div className="server-storage-meter" aria-label={`서버 사용률 ${serverStorage.volume?.usedPercent || 0}%`}>
              <span style={{ width: `${Math.min(100, Number(serverStorage.volume?.usedPercent || 0))}%` }} />
            </div>
            <div className="server-storage-meta">
              <span>사용률 <strong>{serverStorage.volume?.usedPercent || 0}%</strong></span>
              <span>송장 {serverStorage.cleanup?.labels?.files || 0}개</span>
              <span>오래된 배포 백업 {serverStorage.cleanup?.frontendBackups?.count || 0}개</span>
              <span>정리 가능한 로그 {serverStorage.cleanup?.logs?.count || 0}개</span>
            </div>
          </>
        ) : (
          <p>{storageLoading ? '서버 용량을 확인하고 있습니다.' : '용량 새로고침을 눌러 확인하세요.'}</p>
        )}

        <div className="server-storage-actions">
          <button type="button" className="primary-button" onClick={handleServerCleanup} disabled={storageCleanupLoading || storageLoading}>
            {storageCleanupLoading ? '안전 정리 중...' : '안전한 데이터 정리'}
          </button>
          <small>주문·정산·재고·DB·브랜드 배경 이미지는 삭제하지 않습니다.</small>
        </div>
      </section>

      <div className="admin-toolbar">
        <label>
          상태 필터
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            {STATUS_OPTIONS.map((option) => (
              <option value={option.value} key={option.value || 'all'}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}

      <div className="panel admin-panel">
        <div className="panel-header">
          <h2>Tenant 목록</h2>
          <span>{loading ? '불러오는 중...' : `${tenants.length}건`}</span>
        </div>

        <div className="table-wrap admin-table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Tenant</th>
                <th>Main Account</th>
                <th>Owner</th>
                <th>상태</th>
                <th>활성</th>
                <th>승인 정보</th>
                <th>거절/정지 사유</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {tenants.length === 0 ? (
                <tr>
                  <td colSpan="9" className="empty-cell">
                    표시할 tenant가 없습니다.
                  </td>
                </tr>
              ) : (
                tenants.map((tenant) => {
                  const isProtected = tenant.id === 1 || tenant.code === 'GANGNAMCOS';
                  const approveLoading = actionLoading === `approve:${tenant.id}`;
                  const rejectLoading = actionLoading === `reject:${tenant.id}`;
                  const suspendLoading = actionLoading === `suspend:${tenant.id}`;
                  const deleteLoading = actionLoading === `delete:${tenant.id}`;

                  return (
                    <tr key={tenant.id}>
                      <td>{tenant.id}</td>
                      <td>
                        <strong>{tenant.code}</strong>
                        <small>{tenant.name}</small>
                      </td>
                      <td>{tenant.requested_main_account_id || '-'}</td>
                      <td>
                        <strong>{tenant.owner_email || '-'}
                          <br />
                          <small>최근 로그인: {formatDate(tenant.owner_last_login_at)}</small></strong>
                        <small>{tenant.owner_phone || tenant.owner_display_name || '-'}</small>
                      </td>
                      <td>
                        <span className={`status-pill ${tenant.approval_status || 'unknown'}`}>
                          {statusLabel(tenant.approval_status)}
                        </span>
                      </td>
                      <td>{Number(tenant.is_active) === 1 ? '활성' : '비활성'}</td>
                      <td>
                        <small>승인자: {tenant.approved_by_user_id || '-'}</small>
                        <small>{formatDate(tenant.approved_at)}</small>
                      </td>
                      <td>{tenant.rejection_reason || '-'}</td>
                      <td>
                        <div className="admin-actions">
                          <button
                            type="button"
                            className="approve-action"
                            onClick={() => runTenantAction('approve', tenant)}
                            disabled={approveLoading || tenant.approval_status === 'approved'}
                          >
                            {approveLoading ? '처리중' : '승인'}
                          </button>
                          <button
                            type="button"
                            className="danger-outline"
                            onClick={() => runTenantAction('reject', tenant)}
                            disabled={rejectLoading || isProtected}
                          >
                            {rejectLoading ? '처리중' : '거절'}
                          </button>
                          <button
                            type="button"
                            className="danger-outline"
                            onClick={() => runTenantAction('suspend', tenant)}
                            disabled={suspendLoading || isProtected}
                          >
                            {suspendLoading ? '처리중' : '정지'}
                          </button>
                          <button
                            type="button"
                            className="danger-action"
                            onClick={() => runTenantAction('delete', tenant)}
                            disabled={deleteLoading || isProtected}
                            title={isProtected ? '운영 Tenant는 삭제할 수 없습니다.' : 'Tenant와 관련 데이터를 영구 삭제'}
                          >
                            {deleteLoading ? '삭제중' : '삭제'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel admin-panel">
        <div className="panel-header">
          <h2>사용자 목록</h2>
          <span>{users.length}건</span>
        </div>

        <div className="table-wrap admin-table-wrap">
          <table className="data-table admin-table">
            <thead>
              <tr>
                <th>User ID</th>
                <th>Email</th>
                <th>Tenant</th>
                <th>Role</th>
                <th>Platform Admin</th>
                <th>User 활성</th>
                <th>Tenant 상태</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan="7" className="empty-cell">
                    표시할 사용자가 없습니다.
                  </td>
                </tr>
              ) : (
                users.map((user, index) => (
                  <tr key={`${user.id}-${user.tenant_id || 'none'}-${index}`}>
                    <td>{user.id}</td>
                    <td>
                      <strong>{user.email}
                          <br />
                          <small>최근 로그인: {formatDate(user.last_login_at)}</small></strong>
                      <small>{user.phone || user.display_name || '-'}</small>
                    </td>
                    <td>
                      <strong>{user.tenant_code || '-'}</strong>
                      <small>{user.tenant_id || '-'}</small>
                    </td>
                    <td>{user.role || '-'}</td>
                    <td>{Number(user.is_platform_admin) === 1 ? 'Y' : 'N'}</td>
                    <td>{Number(user.is_active) === 1 ? '활성' : '비활성'}</td>
                    <td>
                      <span className={`status-pill ${user.tenant_approval_status || 'unknown'}`}>
                        {statusLabel(user.tenant_approval_status)}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
