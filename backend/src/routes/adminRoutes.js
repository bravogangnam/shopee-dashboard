const express = require('express');
const router = express.Router();

const db = require('../config/database');
const { requireAuth, requirePlatformAdmin } = require('../middleware/auth');
const { deleteTenantBackgrounds } = require('../services/brandBackgroundService');

router.use(requireAuth);
router.use(requirePlatformAdmin);

const VALID_STATUSES = new Set(['pending', 'approved', 'rejected', 'suspended']);

function parseTenantId(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) return null;

  const id = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  return id;
}

function normalizeReason(value) {
  if (typeof value !== 'string') return null;

  const reason = value.trim();
  return reason ? reason : null;
}

function validateReason(reason) {
  if (reason && reason.length > 255) {
    return 'reason must be 255 characters or fewer';
  }

  return null;
}

function isProtectedTenant(tenant) {
  return Number(tenant?.id || 0) === 1 || tenant?.code === 'GANGNAMCOS';
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

async function getTenantScopedTables(conn) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS table_name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME = 'tenant_id'
     ORDER BY TABLE_NAME`
  );

  return rows.map((row) => row.table_name);
}

async function deleteTenantScopedData(conn, tenantId) {
  const tables = await getTenantScopedTables(conn);
  const targetTables = tables.filter((tableName) => tableName !== 'tenants');
  const deletedRows = {};

  // Every statement is constrained by the exact tenant_id. Foreign key checks are
  // disabled only on this dedicated transaction connection so child-table order
  // cannot leave a half-deleted tenant when schemas evolve.
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const tableName of targetTables) {
      const [result] = await conn.query(
        `DELETE FROM ${quoteIdentifier(tableName)} WHERE tenant_id = ?`,
        [tenantId]
      );
      deletedRows[tableName] = Number(result.affectedRows || 0);
    }

    const [tenantResult] = await conn.query('DELETE FROM tenants WHERE id = ?', [tenantId]);
    deletedRows.tenants = Number(tenantResult.affectedRows || 0);
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  return deletedRows;
}

async function getTenantById(conn, tenantId, forUpdate = false) {
  const [rows] = await conn.query(
    `SELECT
       id,
       code,
       name,
       requested_main_account_id,
       approval_status,
       is_active,
       approved_at,
       approved_by_user_id,
       rejected_at,
       rejection_reason
     FROM tenants
     WHERE id = ?
     LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [tenantId]
  );

  return rows[0] || null;
}

function tenantResponse(tenant) {
  if (!tenant) return null;

  return {
    id: tenant.id,
    code: tenant.code,
    name: tenant.name,
    requested_main_account_id: tenant.requested_main_account_id,
    approval_status: tenant.approval_status,
    is_active: Number(tenant.is_active || 0),
    approved_at: tenant.approved_at,
    approved_by_user_id: tenant.approved_by_user_id,
    rejected_at: tenant.rejected_at,
    rejection_reason: tenant.rejection_reason,
  };
}

router.get('/tenants', async (req, res) => {
  try {
    const status = typeof req.query.status === 'string'
      ? req.query.status.trim().toLowerCase()
      : '';

    if (status && !VALID_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status filter',
      });
    }

    const params = [];
    const where = [];

    if (status) {
      where.push('t.approval_status = ?');
      params.push(status);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await db.query(
      `SELECT
         t.id,
         t.code,
         t.name,
         t.requested_main_account_id,
         t.approval_status,
         t.is_active,
         t.approved_at,
         t.approved_by_user_id,
         t.rejected_at,
         t.rejection_reason,
         owner.owner_user_id,
         u.email AS owner_email,
         u.display_name AS owner_display_name,
         u.phone AS owner_phone,
         u.last_login_at AS owner_last_login_at
       FROM tenants t
       LEFT JOIN (
         SELECT tenant_id, MIN(user_id) AS owner_user_id
         FROM tenant_users
         WHERE role = 'owner'
         GROUP BY tenant_id
       ) owner ON owner.tenant_id = t.id
       LEFT JOIN users u ON u.id = owner.owner_user_id
       ${whereSql}
       ORDER BY
         CASE t.approval_status
           WHEN 'pending' THEN 1
           WHEN 'approved' THEN 2
           WHEN 'rejected' THEN 3
           WHEN 'suspended' THEN 4
           ELSE 5
         END,
         t.id ASC`,
      params
    );

    return res.json({
      success: true,
      tenants: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        requested_main_account_id: row.requested_main_account_id,
        approval_status: row.approval_status,
        is_active: Number(row.is_active || 0),
        approved_at: row.approved_at,
        approved_by_user_id: row.approved_by_user_id,
        rejected_at: row.rejected_at,
        rejection_reason: row.rejection_reason,
        owner_user_id: row.owner_user_id,
        owner_email: row.owner_email,
        owner_display_name: row.owner_display_name,
        owner_phone: row.owner_phone,
        owner_last_login_at: row.owner_last_login_at,
      })),
    });
  } catch (err) {
    console.error('[Admin] list tenants failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to list tenants',
    });
  }
});

router.get('/users', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         u.id,
         u.email,
         u.display_name,
         u.phone,
         u.last_login_at,
         u.is_active,
         u.is_platform_admin,
         tu.tenant_id,
         t.code AS tenant_code,
         t.approval_status AS tenant_approval_status,
         t.is_active AS tenant_is_active,
         tu.role,
         tu.is_active AS tenant_user_active
       FROM users u
       LEFT JOIN tenant_users tu ON tu.user_id = u.id
       LEFT JOIN tenants t ON t.id = tu.tenant_id
       ORDER BY u.id ASC, tu.tenant_id ASC`
    );

    return res.json({
      success: true,
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        phone: row.phone,
        last_login_at: row.last_login_at,
        is_active: Number(row.is_active || 0),
        is_platform_admin: Number(row.is_platform_admin || 0),
        tenant_id: row.tenant_id,
        tenant_code: row.tenant_code,
        tenant_approval_status: row.tenant_approval_status,
        tenant_is_active: row.tenant_is_active === null ? null : Number(row.tenant_is_active || 0),
        role: row.role,
        tenant_user_active: row.tenant_user_active === null ? null : Number(row.tenant_user_active || 0),
      })),
    });
  } catch (err) {
    console.error('[Admin] list users failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to list users',
    });
  }
});

router.patch('/tenants/:id/approve', async (req, res) => {
  const tenantId = parseTenantId(req.params.id);

  if (!tenantId) {
    return res.status(400).json({
      success: false,
      error: 'Invalid tenant id',
    });
  }

  const adminUserId = req.user?.user_id || req.user?.id || null;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const tenant = await getTenantById(conn, tenantId, true);
    if (!tenant) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        error: 'Tenant not found',
      });
    }

    await conn.query(
      `UPDATE tenants
       SET
         approval_status = 'approved',
         is_active = 1,
         approved_at = NOW(),
         approved_by_user_id = ?,
         rejected_at = NULL,
         rejection_reason = NULL
       WHERE id = ?`,
      [adminUserId, tenantId]
    );

    const updatedTenant = await getTenantById(conn, tenantId, false);

    await conn.commit();

    return res.json({
      success: true,
      tenant: tenantResponse(updatedTenant),
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[Admin] approve tenant failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to approve tenant',
    });
  } finally {
    conn.release();
  }
});

router.patch('/tenants/:id/reject', async (req, res) => {
  const tenantId = parseTenantId(req.params.id);
  const reason = normalizeReason(req.body?.reason);
  const reasonError = validateReason(reason);

  if (!tenantId) {
    return res.status(400).json({
      success: false,
      error: 'Invalid tenant id',
    });
  }

  if (reasonError) {
    return res.status(400).json({
      success: false,
      error: reasonError,
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const tenant = await getTenantById(conn, tenantId, true);
    if (!tenant) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        error: 'Tenant not found',
      });
    }

    if (isProtectedTenant(tenant)) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: 'Protected tenant cannot be rejected',
        code: 'PROTECTED_TENANT',
      });
    }

    await conn.query(
      `UPDATE tenants
       SET
         approval_status = 'rejected',
         is_active = 0,
         approved_at = NULL,
         approved_by_user_id = NULL,
         rejected_at = NOW(),
         rejection_reason = ?
       WHERE id = ?`,
      [reason, tenantId]
    );

    const updatedTenant = await getTenantById(conn, tenantId, false);

    await conn.commit();

    return res.json({
      success: true,
      tenant: tenantResponse(updatedTenant),
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[Admin] reject tenant failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to reject tenant',
    });
  } finally {
    conn.release();
  }
});

router.patch('/tenants/:id/suspend', async (req, res) => {
  const tenantId = parseTenantId(req.params.id);
  const reason = normalizeReason(req.body?.reason) || 'Suspended by admin';
  const reasonError = validateReason(reason);

  if (!tenantId) {
    return res.status(400).json({
      success: false,
      error: 'Invalid tenant id',
    });
  }

  if (reasonError) {
    return res.status(400).json({
      success: false,
      error: reasonError,
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const tenant = await getTenantById(conn, tenantId, true);
    if (!tenant) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        error: 'Tenant not found',
      });
    }

    if (isProtectedTenant(tenant)) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: 'Protected tenant cannot be suspended',
        code: 'PROTECTED_TENANT',
      });
    }

    await conn.query(
      `UPDATE tenants
       SET
         approval_status = 'suspended',
         is_active = 0,
         rejected_at = NOW(),
         rejection_reason = ?
       WHERE id = ?`,
      [reason, tenantId]
    );

    const updatedTenant = await getTenantById(conn, tenantId, false);

    await conn.commit();

    return res.json({
      success: true,
      tenant: tenantResponse(updatedTenant),
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[Admin] suspend tenant failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to suspend tenant',
    });
  } finally {
    conn.release();
  }
});

router.delete('/tenants/:id', async (req, res) => {
  const tenantId = parseTenantId(req.params.id);
  const confirmationCode = String(req.body?.confirmationCode || '').trim();

  if (!tenantId) {
    return res.status(400).json({ success: false, error: 'Invalid tenant id' });
  }

  const adminUserId = Number(req.user?.user_id || req.user?.id || 0) || null;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const tenant = await getTenantById(conn, tenantId, true);
    if (!tenant) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    if (isProtectedTenant(tenant)) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: 'Protected tenant cannot be deleted',
        code: 'PROTECTED_TENANT',
      });
    }

    if (confirmationCode !== tenant.code) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        error: 'Tenant confirmation code does not match',
        code: 'CONFIRMATION_MISMATCH',
      });
    }

    if (adminUserId) {
      const [[currentAdminMembership]] = await conn.query(
        `SELECT 1 AS found
         FROM tenant_users
         WHERE tenant_id = ? AND user_id = ?
         LIMIT 1`,
        [tenantId, adminUserId]
      );

      if (currentAdminMembership) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          error: 'The tenant containing the current administrator cannot be deleted',
          code: 'CURRENT_ADMIN_TENANT',
        });
      }
    }

    const [memberRows] = await conn.query(
      'SELECT DISTINCT user_id FROM tenant_users WHERE tenant_id = ? FOR UPDATE',
      [tenantId]
    );
    const memberUserIds = memberRows.map((row) => Number(row.user_id)).filter(Number.isSafeInteger);

    const deletedRows = await deleteTenantScopedData(conn, tenantId);

    let deletedUsers = 0;
    if (memberUserIds.length > 0) {
      const placeholders = memberUserIds.map(() => '?').join(', ');
      const [userResult] = await conn.query(
        `DELETE u
         FROM users u
         WHERE u.id IN (${placeholders})
           AND u.is_platform_admin = 0
           AND NOT EXISTS (
             SELECT 1 FROM tenant_users tu WHERE tu.user_id = u.id
           )`,
        memberUserIds
      );
      deletedUsers = Number(userResult.affectedRows || 0);
    }

    await conn.commit();
    await deleteTenantBackgrounds(tenantId).catch((error) => {
      console.error(`[Admin] tenant background cleanup failed: tenant=${tenantId}: ${error.message}`);
    });

    return res.json({
      success: true,
      deletedTenant: { id: tenant.id, code: tenant.code },
      deletedUsers,
      deletedRows,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[Admin] delete tenant failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete tenant',
    });
  } finally {
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch (_) {}
    conn.release();
  }
});

module.exports = router;
