#!/usr/bin/env node

const path = require('path');

const localEnvPath = path.resolve(__dirname, '../.env');
const productionEnvPath = '/var/www/shopee-dashboard/backend/.env';

require('dotenv').config({ path: localEnvPath });
require('dotenv').config({ path: productionEnvPath, override: false });

const db = require('../src/config/database');

const apply = process.argv.includes('--apply');

const tenantColumns = [
  {
    name: 'requested_main_account_id',
    sql: 'ALTER TABLE tenants ADD COLUMN requested_main_account_id BIGINT NULL AFTER name',
  },
  {
    name: 'approval_status',
    sql: "ALTER TABLE tenants ADD COLUMN approval_status ENUM('pending','approved','rejected','suspended') NOT NULL DEFAULT 'pending' AFTER is_active",
  },
  {
    name: 'approved_at',
    sql: 'ALTER TABLE tenants ADD COLUMN approved_at DATETIME NULL AFTER approval_status',
  },
  {
    name: 'approved_by_user_id',
    sql: 'ALTER TABLE tenants ADD COLUMN approved_by_user_id BIGINT NULL AFTER approved_at',
  },
  {
    name: 'rejected_at',
    sql: 'ALTER TABLE tenants ADD COLUMN rejected_at DATETIME NULL AFTER approved_by_user_id',
  },
  {
    name: 'rejection_reason',
    sql: 'ALTER TABLE tenants ADD COLUMN rejection_reason VARCHAR(255) NULL AFTER rejected_at',
  },
];

const userColumns = [
  {
    name: 'phone',
    sql: 'ALTER TABLE users ADD COLUMN phone VARCHAR(50) NULL AFTER display_name',
  },
  {
    name: 'is_platform_admin',
    sql: 'ALTER TABLE users ADD COLUMN is_platform_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active',
  },
];

async function getColumns(tableName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [tableName]
  );

  return new Set(rows.map((row) => row.COLUMN_NAME));
}

function expr(columns, columnName, fallbackSql) {
  return columns.has(columnName) ? columnName : `${fallbackSql} AS ${columnName}`;
}

async function printColumnStatus() {
  const tenants = await getColumns('tenants');
  const users = await getColumns('users');

  console.log('===== column status: tenants =====');
  for (const col of tenantColumns) {
    console.log(`${col.name}=${tenants.has(col.name) ? 'exists' : 'missing'}`);
  }

  console.log('===== column status: users =====');
  for (const col of userColumns) {
    console.log(`${col.name}=${users.has(col.name) ? 'exists' : 'missing'}`);
  }

  return { tenants, users };
}

async function printSummary() {
  const tenantCols = await getColumns('tenants');
  const userCols = await getColumns('users');

  const tenantSelect = [
    'id',
    'code',
    'name',
    expr(tenantCols, 'requested_main_account_id', 'NULL'),
    'is_active',
    expr(tenantCols, 'approval_status', "'not_added'"),
    expr(tenantCols, 'approved_at', 'NULL'),
    expr(tenantCols, 'approved_by_user_id', 'NULL'),
    expr(tenantCols, 'rejected_at', 'NULL'),
    expr(tenantCols, 'rejection_reason', 'NULL'),
  ].join(', ');

  const userSelect = [
    'id',
    'email',
    'display_name',
    expr(userCols, 'phone', 'NULL'),
    'is_active',
    expr(userCols, 'is_platform_admin', '0'),
    'last_login_at',
  ].join(', ');

  console.log('===== tenants summary =====');
  const [tenantRows] = await db.query(`
    SELECT ${tenantSelect}
    FROM tenants
    ORDER BY id
  `);
  console.table(tenantRows);

  console.log('===== users summary =====');
  const [userRows] = await db.query(`
    SELECT ${userSelect}
    FROM users
    ORDER BY id
  `);
  console.table(userRows);

  console.log('===== tenant_users summary =====');

  const approvalExpr = tenantCols.has('approval_status')
    ? 't.approval_status'
    : "'not_added' AS approval_status";

  const platformAdminExpr = userCols.has('is_platform_admin')
    ? 'u.is_platform_admin'
    : '0 AS is_platform_admin';

  const [mappingRows] = await db.query(`
    SELECT
      tu.tenant_id,
      t.code AS tenant_code,
      ${approvalExpr},
      t.is_active AS tenant_active,
      u.email,
      ${platformAdminExpr},
      tu.role,
      tu.is_active AS tenant_user_active
    FROM tenant_users tu
    JOIN tenants t ON t.id = tu.tenant_id
    JOIN users u ON u.id = tu.user_id
    ORDER BY tu.tenant_id, tu.id
  `);
  console.table(mappingRows);
}

async function applyMissingColumns(tableName, columns) {
  const existing = await getColumns(tableName);

  for (const col of columns) {
    if (existing.has(col.name)) {
      console.log(`skip ${tableName}.${col.name}: exists`);
      continue;
    }

    console.log(`apply ${tableName}.${col.name}`);
    await db.query(col.sql);
  }
}

async function applyBackfill() {
  await db.query('START TRANSACTION');

  try {
    await db.query(`
      UPDATE tenants
      SET
        approval_status = 'approved',
        is_active = 1,
        approved_at = COALESCE(approved_at, NOW()),
        approved_by_user_id = COALESCE(
          approved_by_user_id,
          (SELECT id FROM users WHERE email = 'owner@gangnamcos.local' LIMIT 1)
        )
      WHERE id IN (
        SELECT DISTINCT tenant_id
        FROM tenant_users
      )
    `);

    await db.query(`
      UPDATE users
      SET
        is_platform_admin = 1,
        is_active = 1
      WHERE email = 'owner@gangnamcos.local'
    `);

    await db.query(`
      UPDATE users
      SET is_platform_admin = 0
      WHERE email = 'test-owner@example.com'
    `);

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  console.log('===== applyApprovalFieldsMigration =====');
  console.log(`mode=${apply ? 'APPLY' : 'DRY_RUN'}`);

  await printColumnStatus();

  console.log('===== planned columns =====');
  for (const col of tenantColumns) {
    console.log(`tenants.${col.name}`);
  }
  for (const col of userColumns) {
    console.log(`users.${col.name}`);
  }

  await printSummary();

  if (!apply) {
    console.log('DRY_RUN only. Re-run with --apply to alter/update.');
    await db.end();
    return;
  }

  console.log('===== applying schema changes =====');
  await applyMissingColumns('tenants', tenantColumns);
  await applyMissingColumns('users', userColumns);

  console.log('===== applying existing data backfill =====');
  await applyBackfill();

  console.log('===== result summary =====');
  await printColumnStatus();
  await printSummary();

  await db.end();
}

main().catch(async (err) => {
  console.error('applyApprovalFieldsMigration failed:', err.message);
  try {
    await db.end();
  } catch (_) {}
  process.exit(1);
});
