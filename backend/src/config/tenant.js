/**
 * Tenant context helpers
 *
 * Step 1 used CURRENT_TENANT_ID=1 for safe single-tenant scoping.
 * Step 2-lite keeps that fallback, but allows request/JWT-provided tenant_id
 * to become the source of truth later.
 */

const CURRENT_TENANT_ID = 1;

function normalizeTenantId(value) {
  const tenantId = Number.parseInt(value, 10);
  if (Number.isInteger(tenantId) && tenantId > 0) {
    return tenantId;
  }
  return CURRENT_TENANT_ID;
}

function getCurrentTenantId(req) {
  return normalizeTenantId(
    req?.tenantId ??
    req?.user?.tenant_id ??
    req?.user?.tenantId ??
    CURRENT_TENANT_ID
  );
}

module.exports = {
  CURRENT_TENANT_ID,
  normalizeTenantId,
  getCurrentTenantId,
};
