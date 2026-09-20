
/** Server-Sent Events hub for real-time log streaming. */
const clients = new Set();

export function addSseClient(res) {
  clients.add(res);
  res.write('retry: 3000\n\n');
  res.on('close', () => clients.delete(res));
  res.on('error', () => clients.delete(res));
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

const heartbeat = setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }
}, 15000);
heartbeat.unref?.();

export function clientCount() { return clients.size; }
