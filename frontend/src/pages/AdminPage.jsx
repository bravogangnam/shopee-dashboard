import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  approveTenant,
  fetchAdminTenants,
  fetchAdminUsers,
  rejectTenant,
  suspendTenant,
} from '../api/admin.js';

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

export default function AdminPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [tenants, setTenants] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

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

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  async function runTenantAction(type, tenant) {
    const reasonRequired = type === 'reject' || type === 'suspend';
    let reason = '';

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

                  return (
                    <tr key={tenant.id}>
                      <td>{tenant.id}</td>
                      <td>
                        <strong>{tenant.code}</strong>
                        <small>{tenant.name}</small>
                      </td>
                      <td>{tenant.requested_main_account_id || '-'}</td>
                      <td>
                        <strong>{tenant.owner_email || '-'}</strong>
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
                      <strong>{user.email}</strong>
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
