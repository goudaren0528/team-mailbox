import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

export const accessConfig = {
  allowedCidrs: ['127.0.0.0/24', '::1/128'],
  members: [{ name: 'A', ips: ['127.0.0.1', '::1'] }, { name: 'B', ips: ['127.0.0.2'] }, { name: 'C', ips: ['127.0.0.3'] }],
};

const cleanups = new WeakMap();
export function cleanup(t, fn) {
  if (!cleanups.has(t)) {
    const stack = [];
    cleanups.set(t, stack);
    t.after(async () => {
      const errors = [];
      for (const dispose of stack.reverse()) {
        try { await dispose(); } catch (err) { errors.push(err); }
      }
      if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
    });
  }
  cleanups.get(t).push(fn);
}

export function temp(t) {
  const root = path.resolve('.test-tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  cleanup(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function fixture(t, config = accessConfig, host = '127.0.0.1') {
  const dir = temp(t);
  const accessConfigPath = path.join(dir, 'access.json');
  const dbPath = path.join(dir, 'msg.sqlite');
  fs.writeFileSync(accessConfigPath, JSON.stringify(config));
  let app = createServer({ accessConfigPath, dbPath });
  let info = await app.start(0, host);
  cleanup(t, async () => { if (app) { app.server.closeAllConnections(); await app.close(); } });
  return {
    dir, dbPath, accessConfigPath,
    get app() { return app; },
    get url() { return `http://${host.includes(':') ? `[${host}]` : host}:${info.port}`; },
    async restart(config) {
      app.server.closeAllConnections(); await app.close(); app = null;
      if (config) fs.writeFileSync(accessConfigPath, JSON.stringify(config));
      app = createServer({ accessConfigPath, dbPath });
      info = await app.start(0, host);
    },
  };
}

// timeoutMs is raised only by attachment cases; multi-MiB bodies legitimately
// take longer than the 5s that suits text traffic.
export function request(url, localAddress = '127.0.0.1', method = 'GET', body, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(url, { localAddress, method, agent: false,
      headers: { ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(text) }); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Test request timed out')));
    req.end(raw);
  });
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Builds a well-formed attachment payload; individual tests override one field
// at a time so each assertion isolates exactly one rule.
export function attachmentPayload(name, contents, overrides = {}) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  return { name, data_base64: data.toString('base64'), sha256: sha256(data), ...overrides };
}

// Test-only relay gives each real SDK process a different real TCP source.
// It forwards bytes/headers; production still sees only socket.remoteAddress.
export async function relay(t, target, localAddress, prefix = '') {
  const server = http.createServer((req, res) => {
    const route = prefix && req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url;
    const upstream = http.request(new URL(route, target), { localAddress, method: req.method, headers: req.headers, agent: false }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}${prefix}`;
}
