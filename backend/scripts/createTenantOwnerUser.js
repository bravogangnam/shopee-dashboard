#!/usr/bin/env node

require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('../src/config/database');

const DEFAULT_TENANT_ID = 1;
const DEFAULT_ROLE = 'owner';

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const tenantId = Number.parseInt(argValue('tenant-id') || process.env.OWNER_TENANT_ID || DEFAULT_TENANT_ID, 10);
  const email = (argValue('email') || process.env.OWNER_EMAIL || 'owner@gangnamcos.local').trim().toLowerCase();
  const password = argValue('password') || process.env.OWNER_PASSWORD || process.env.APP_PASSWORD;
  const displayName = argValue('display-name') || process.env.OWNER_DISPLAY_NAME || 'GANGNAMCOS Owner';
  const role = argValue('role') || process.env.OWNER_ROLE || DEFAULT_ROLE;

  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`Invalid tenant id: ${tenantId}`);
  }

  if (!email || !email.includes('@')) {
    throw new Error(`Invalid email: ${email}`);
  }

  if (!password || password.length < 4) {
    throw new Error('OWNER_PASSWORD or APP_PASSWORD is required and must be at least 4 characters.');
  }

  const [[tenant]] = await db.query(
    'SELECT id, code, name, is_active FROM tenants WHERE id = ? LIMIT 1',
    [tenantId]
  );

  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  const [existingUsers] = await db.query(
    'SELECT id, email, display_name, is_active FROM users WHERE email = ? LIMIT 1',
    [email]
  );

  const existingUser = existingUsers[0] || null;

  console.log('===== createTenantOwnerUser plan =====');
  console.log(`mode=${apply ? 'APPLY' : 'DRY_RUN'}`);
  console.log(`tenant_id=${tenantId}`);
  console.log(`tenant_code=${tenant.code}`);
  console.log(`email=${email}`);
  console.log(`display_name=${displayName}`);
  console.log(`role=${role}`);
  console.log(`existing_user_id=${existingUser ? existingUser.id : 'none'}`);

  if (!apply) {
    console.log('DRY_RUN only. Re-run with --apply to insert/update.');
    await db.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.query('START TRANSACTION');

  try {
    let userId;

    if (existingUser) {
      userId = existingUser.id;
      await db.query(
        `UPDATE users
         SET password_hash = ?, display_name = ?, is_active = 1, updated_at = NOW()
         WHERE id = ?`,
        [passwordHash, displayName, userId]
      );
    } else {
      const [result] = await db.query(
        `INSERT INTO users (email, password_hash, display_name, is_active)
         VALUES (?, ?, ?, 1)`,
        [email, passwordHash, displayName]
      );
      userId = result.insertId;
    }

    await db.query(
      `INSERT INTO tenant_users (tenant_id, user_id, role, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         role = VALUES(role),
         is_active = 1,
         updated_at = NOW()`,
      [tenantId, userId, role]
    );

    await db.query('COMMIT');

    const [[userCount]] = await db.query('SELECT COUNT(*) AS count FROM users');
    const [[tenantUserCount]] = await db.query('SELECT COUNT(*) AS count FROM tenant_users');

    console.log('APPLY complete.');
    console.log(`user_id=${userId}`);
    console.log(`users_count=${userCount.count}`);
    console.log(`tenant_users_count=${tenantUserCount.count}`);
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    await db.end();
  }
}

main().catch(async (err) => {
  console.error('createTenantOwnerUser failed:', err.message);
  try {
    await db.end();
  } catch (_) {}
  process.exit(1);
});
