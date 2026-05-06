const CURRENT_TENANT_ID = 1;

/**
 * Temporary tenant helper for SaaS migration step 1.
 *
 * Current production dashboard is single-tenant GANGNAMCOS.
 * Until user/tenant login is implemented, every request is scoped to tenant_id=1.
 *
 * Later this function should read tenant_id from the authenticated user/session.
 */
function getCurrentTenantId(req) {
  return CURRENT_TENANT_ID;
}

module.exports = {
  CURRENT_TENANT_ID,
  getCurrentTenantId,
};
