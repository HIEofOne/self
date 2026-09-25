/**
 * Serve an app for supertest on 127.0.0.1.
 *
 * supertest's request(app) starts the app on a random port bound to [::]
 * and then connects to 127.0.0.1. On macOS the kernel can hand that [::]
 * listener a port another program already holds on 127.0.0.1 (seen: a
 * VS Code helper process), and the request goes to that program instead:
 * an intermittent 404 with an empty body. Binding 127.0.0.1 ourselves
 * rules that out, since the kernel never gives out a port held there.
 *
 *   const server = await serve(app);
 *   await request(server).get('/api/...');
 *
 * Every server is closed when its test file ends (tests/setup.js).
 */
import http from 'http';

const open = new Set();

export async function serve(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  open.add(server);
  return server;
}

export async function closeServed() {
  const servers = [...open];
  open.clear();
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
}
