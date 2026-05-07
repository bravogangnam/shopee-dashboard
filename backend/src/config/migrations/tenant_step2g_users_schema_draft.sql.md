# Tenant Step 2G - Users schema draft

Status: DRAFT ONLY. Do not apply automatically.

Purpose:
- Existing production data remains under tenant_id = 1.
- Existing tenants table already exists and must not be recreated.
- This draft adds only user/account mapping tables needed for future multi-user login.
- Existing APP_PASSWORD login remains compatible until a later auth migration.

Existing assumptions:
- tenants table already exists.
- Do not recreate or overwrite tenants.
- Do not modify existing tenant_id=1 data.

Proposed table 1: users

CREATE TABLE IF NOT EXISTS users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NULL,
  display_name VARCHAR(100) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_users_email (email),
  KEY idx_users_active (is_active)
);

Proposed table 2: tenant_users

CREATE TABLE IF NOT EXISTS tenant_users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  role ENUM('owner','admin','staff','viewer') NOT NULL DEFAULT 'owner',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_user (tenant_id, user_id),
  KEY idx_tenant_users_user (user_id),
  KEY idx_tenant_users_tenant (tenant_id),
  KEY idx_tenant_users_active (is_active)
);

Optional foreign keys, only if current DB engine and operations policy allow it:

-- ALTER TABLE tenant_users
--   ADD CONSTRAINT fk_tenant_users_tenant
--   FOREIGN KEY (tenant_id) REFERENCES tenants(id);
--
-- ALTER TABLE tenant_users
--   ADD CONSTRAINT fk_tenant_users_user
--   FOREIGN KEY (user_id) REFERENCES users(id);

Backfill plan:
- Do not insert users yet in this draft PR.
- Do not create owner user yet.
- Decide email, password hashing method, and APP_PASSWORD fallback policy first.

Later example only:

-- INSERT INTO users (email, password_hash, display_name)
-- VALUES ('owner@example.com', '<bcrypt_hash>', 'Owner');
--
-- INSERT INTO tenant_users (tenant_id, user_id, role)
-- SELECT 1, id, 'owner'
-- FROM users
-- WHERE email = 'owner@example.com';

Later auth migration plan:
1. Keep APP_PASSWORD login fallback.
2. Add optional email/password login.
3. On login, resolve user to tenant_users to tenant_id.
4. Generate JWT with user_id, tenant_id, role.
5. Keep tenant_id=1 fallback until the new login is tested.
6. Only then consider reducing CURRENT_TENANT_ID fallback usage.

Safety rules:
- No existing table data should be modified by this draft.
- No existing tenant_id=1 data should be touched.
- No main_account, shops, orders, inventory, jobs data should be changed.
- Do not replace the current login flow in the same PR as table creation.
