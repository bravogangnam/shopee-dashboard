import { getStoredToken } from './client.js';

export function subscribeToOrderEvents(onOrderChange) {
  const controller = new AbortController();
  let reconnectTimer = null;

  async function connect() {
    try {
      const token = getStoredToken();
      const response = await fetch('/api/orders/events', {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';
        for (const message of messages) {
          if (!message.includes('event: order-change')) continue;
          const dataLine = message.split('\n').find(line => line.startsWith('data: '));
          if (dataLine) onOrderChange(JSON.parse(dataLine.slice(6)));
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[OrderEvents] disconnected:', err.message);
    }
    if (!controller.signal.aborted) reconnectTimer = window.setTimeout(connect, 3000);
  }

  connect();
  return () => {
    controller.abort();
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
  };
}
