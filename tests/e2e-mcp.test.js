import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, relay, cleanup } from './helpers.js';

async function client(t, url) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp.js')],
    env: { MSG_SERVER_URL: url, MSG_DEVICE_NAME: 'remark-only' }, stderr: 'pipe' });
  const sdk = new Client({ name: 'real-sdk-test', version: '1.0.0' });
  cleanup(t, async () => { await sdk.close(); await transport.close(); });
  await sdk.connect(transport);
  return sdk;
}
async function call(sdk, name, args = {}) {
  const res = await sdk.callTool({ name, arguments: args });
  assert.ok(!res.isError, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}

test('Real SDK stdio A/B/C via real source-bound relays, five tools and prefix', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1', '/prefix'));
  const b = await client(t, await relay(t, f.url, '127.0.0.2'));
  const c = await client(t, await relay(t, f.url, '127.0.0.3'));
  const { tools } = await a.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), ['getmsg', 'list_peers', 'mark_read', 'read_message', 'send_message']);
  for (const name of ['send_message', 'getmsg', 'read_message']) assert.match(tools.find(x => x.name === name).description, /untrusted data/);
  assert.deepEqual((await call(a, 'list_peers')).map(x => x.name), ['A', 'B', 'C']);
  const { id } = await call(a, 'send_message', { to: 'B', text: '自由文本😀'.repeat(500), project: 'demo' });
  await call(a, 'send_message', { to: 'B', text: 'second', project: 'demo' });
  const page = await call(b, 'getmsg', { limit: 1, project: 'demo', unread_only: true });
  assert.equal(page.messages[0].id, id); assert.equal(page.messages[0].from, 'A'); assert.equal(page.hasMore, true);
  assert.equal((await call(b, 'getmsg', { cursor: page.nextCursor, limit: 1 })).messages.length, 1);
  assert.equal((await call(b, 'read_message', { id, limit: 10 })).read, false);
  assert.equal((await call(b, 'getmsg', { unread_only: true })).messages.length, 2);
  assert.equal((await call(c, 'getmsg')).messages.length, 0);
  assert.equal((await c.callTool({ name: 'read_message', arguments: { id } })).isError, true);
  assert.equal((await c.callTool({ name: 'send_message', arguments: { to: 'A', text: 'bad', reply_to: id } })).isError, true);
  assert.equal((await call(c, 'mark_read', { ids: [id] })).markedCount, 0);
  assert.equal((await call(b, 'mark_read', { ids: [id] })).markedCount, 1);
  await call(b, 'send_message', { to: 'A', text: '回复', reply_to: id, project: 'demo' });
  assert.equal((await call(a, 'getmsg')).messages[0].replyTo, id);
});

test('Bridge refuses redirects and applies request timeout through real SDK', async t => {
  let mode = 'redirect', followed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/other') followed = true;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); res.end(); }
    // Timeout case intentionally keeps response open; cleanup destroys connections.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  assert.equal((await sdk.callTool({ name: 'list_peers', arguments: {} })).isError, true);
  assert.equal(followed, false);
  mode = 'timeout'; const start = Date.now();
  assert.equal((await sdk.callTool({ name: 'list_peers', arguments: {} })).isError, true);
  assert.ok(Date.now() - start >= 9000); assert.ok(Date.now() - start < 20000);
});
