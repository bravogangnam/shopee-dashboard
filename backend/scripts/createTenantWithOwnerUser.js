#!/usr/bin/env node

require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('../src/config/database');

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function normalizeTenantCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function main() {
  const apply = process.argv.includes('--apply');

  const tenantCode = normalizeTenantCode(argValue('tenant-code') || process.env.NEW_TENANT_CODE);
  const tenantName = (argValue('tenant-name') || process.env.NEW_TENANT_NAME || tenantCode).trim();
  const email = (argValue('email') || process.env.NEW_OWNER_EMAIL || '').trim().toLowerCase();
  const password = argValue('password') || process.env.NEW_OWNER_PASSWORD;
  const displayName = argValue('display-name') || process.env.NEW_OWNER_DISPLAY_NAME || tenantName + ' Owner';
  const role = argValue('role') || process.env.NEW_OWNER_ROLE || 'owner';

  if (!tenantCode || tenantCode.length < 2) throw new Error('tenant-code is required. Example: --tenant-code=TESTSHOP');
  if (!tenantName) throw new Error('tenant-name is required.');
  if (!email || !email.includes('@')) throw new Error('valid email is required. Example: --email=owner@example.com');
  if (!password || password.length < 4) throw new Error('password is required and must be at least 4 characters.');
  if (!['owner', 'admin', 'staff', 'viewer'].includes(role)) throw new Error(`invalid role: ${role}`);

  const [tenantRows] = await db.query(
    'SELECT id, code, name, is_active FROM tenants WHERE code = ? LIMIT 1',
    [tenantCode]
  );

  const [userRows] = await db.query(
    'SELECT id, email, display_name, is_active FROM users WHERE email = ? LIMIT 1',
    [email]
  );

  const existingTenant = tenantRows[0] || null;
  const existingUser = userRows[0] || null;

  console.log('===== createTenantWithOwnerUser plan =====');
  console.log(`mode=${apply ? 'APPLY' : 'DRY_RUN'}`);
  console.log(`tenant_code=${tenantCode}`);
  console.log(`tenant_name=${tenantName}`);
  console.log(`owner_email=${email}`);
  console.log(`owner_display_name=${displayName}`);
  console.log(`role=${role}`);
  console.log(`existing_tenant_id=${existingTenant ? existingTenant.id : 'none'}`);
  console.log(`existing_user_id=${existingUser ? existingUser.id : 'none'}`);

  if (existingTenant) throw new Error(`Tenant code already exists: ${tenantCode}`);
  if (existingUser) throw new Error(`Owner email already exists: ${email}`);

  if (!apply) {
    console.log('DRY_RUN only. Re-run with --apply to create tenant/user.');
    await db.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.query('START TRANSACTION');

  try {
    const [lastTenantRows] = await db.query(
      'SELECT id FROM tenants ORDER BY id DESC LIMIT 1 FOR UPDATE'
    );

    const tenantId = Number(lastTenantRows[0]?.id || 0) + 1;

    await db.query(
      `INSERT INTO tenants (id, code, name, is_active)
       VALUES (?, ?, ?, 1)`,
      [tenantId, tenantCode, tenantName]
    );

    const [userResult] = await db.query(
      `INSERT INTO users (email, password_hash, display_name, is_active)
       VALUES (?, ?, ?, 1)`,
      [email, passwordHash, displayName]
    );

    const userId = userResult.insertId;

    await db.query(
      `INSERT INTO tenant_users (tenant_id, user_id, role, is_active)
       VALUES (?, ?, ?, 1)`,
      [tenantId, userId, role]
    );

    await db.query('COMMIT');

    console.log('APPLY complete.');
    console.log(`tenant_id=${tenantId}`);
    console.log(`user_id=${userId}`);
    console.log(`tenant_code=${tenantCode}`);
    console.log(`owner_email=${email}`);
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    await db.end();
  }
}

main().catch(async (err) => {
  console.error('createTenantWithOwnerUser failed:', err.message);
  try { await db.end(); } catch (_) {}
  process.exit(1);
});
