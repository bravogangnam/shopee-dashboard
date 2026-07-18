const clientsByTenant = new Map();

function addClient(tenantId, res) {
  const key = Number(tenantId);
  if (!clientsByTenant.has(key)) clientsByTenant.set(key, new Set());
  clientsByTenant.get(key).add(res);
  return () => {
    const clients = clientsByTenant.get(key);
    if (!clients) return;
    clients.delete(res);
    if (!clients.size) clientsByTenant.delete(key);
  };
}

function publishOrderChange(tenantId, payload) {
  const clients = clientsByTenant.get(Number(tenantId));
  if (!clients) return 0;
  const message = `event: order-change\ndata: ${JSON.stringify(payload)}\n\n`;
  let sent = 0;
  for (const res of clients) {
    if (res.destroyed || res.writableEnded) continue;
    res.write(message);
    sent += 1;
  }
  return sent;
}

module.exports = { addClient, publishOrderChange };
