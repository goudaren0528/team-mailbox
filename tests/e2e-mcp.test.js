import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, relay, cleanup, temp, sha256 } from './helpers.js';

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
  assert.deepEqual(tools.map(x => x.name).sort(), ['getmsg', 'list_peers', 'mark_read', 'read_attachment_text', 'read_message', 'save_attachment', 'send_file', 'send_message']);
  for (const name of ['send_message', 'getmsg', 'read_message', 'send_file', 'save_attachment', 'read_attachment_text']) {
    assert.match(tools.find(x => x.name === name).description, /untrusted data/);
  }
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
  assert.equal((await call(c, 'mark_read', { ids: [id] })).markedCount, 0);
  assert.equal((await call(b, 'mark_read', { ids: [id] })).markedCount, 1);

  // reply_to is gone from both send tools' published schemas and from every response.
  for (const name of ['send_message', 'send_file']) {
    const schema = tools.find(x => x.name === name).inputSchema;
    assert.equal('reply_to' in (schema.properties ?? {}), false, `${name} must not publish reply_to`);
    assert.equal(JSON.stringify(schema).includes('reply_to'), false, `${name} schema mentions reply_to`);
  }
  await call(b, 'send_message', { to: 'A', text: '后续说明', project: 'demo' });
  const inboxA = (await call(a, 'getmsg')).messages[0];
  assert.equal('replyTo' in inboxA, false, 'getmsg must not return replyTo');
  assert.equal('replyTo' in (await call(a, 'read_message', { id: inboxA.id })), false, 'read_message must not return replyTo');
});

test('Real SDK stdio file transfer: send_file to getmsg to save_attachment to read_attachment_text', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'));
  const b = await client(t, await relay(t, f.url, '127.0.0.2'));
  const c = await client(t, await relay(t, f.url, '127.0.0.3'));
  const dir = temp(t);

  const contents = `# 排查记录\n${'内容行😀\n'.repeat(400)}`;
  const source = path.join(dir, '排查记录.md');
  fs.writeFileSync(source, contents, 'utf8');
  const digest = sha256(fs.readFileSync(source));

  const sent = await call(a, 'send_file', { to: 'B', path: source, title: '记录', text: '见附件', project: 'demo' });
  assert.equal(sent.attachment.name, '排查记录.md');
  assert.equal(sent.attachment.sha256, digest);

  const listed = (await call(b, 'getmsg', { unread_only: true })).messages.at(-1);
  assert.equal(listed.attachment.id, sent.attachment.id);
  assert.equal(listed.attachment.size, sent.attachment.size);
  const attachmentId = listed.attachment.id;
  assert.equal((await call(b, 'read_message', { id: sent.id, limit: 10 })).attachment.sha256, digest);

  // Sender and third party are refused through the real bridge as well.
  for (const sdk of [a, c]) {
    const denied = await sdk.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: path.join(dir, 'stolen.md') } });
    assert.equal(denied.isError, true);
    assert.equal(denied.content[0].text.includes('排查记录'), false, 'denial must not leak the file name');
    assert.equal((await sdk.callTool({ name: 'read_attachment_text', arguments: { attachment_id: attachmentId } })).isError, true);
  }
  assert.equal(fs.existsSync(path.join(dir, 'stolen.md')), false);

  const target = path.join(dir, 'saved.md');
  const saved = await call(b, 'save_attachment', { attachment_id: attachmentId, path: target });
  assert.equal(saved.sha256, digest);
  assert.equal(fs.readFileSync(target, 'utf8'), contents, 'saved file matches the source byte-for-byte');

  // Local write guards: refuse overwrite, relative path, and missing parent.
  const clash = await b.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: target } });
  assert.equal(clash.isError, true);
  assert.match(clash.content[0].text, /already exists/);
  fs.writeFileSync(target, 'sentinel', 'utf8');
  assert.equal((await b.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: target } })).isError, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel', 'a refused save leaves the existing file untouched');
  assert.equal((await call(b, 'save_attachment', { attachment_id: attachmentId, path: target, overwrite: true })).sha256, digest);
  assert.equal(fs.readFileSync(target, 'utf8'), contents, 'explicit overwrite replaces the file');

  const relative = await b.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: 'relative.md' } });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /absolute/);
  assert.equal(fs.existsSync(path.resolve('relative.md')), false);

  const missingParent = await b.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: path.join(dir, 'no-such-dir', 'x.md') } });
  assert.equal(missingParent.isError, true);
  assert.match(missingParent.content[0].text, /Parent directory does not exist/);

  let joined = ''; let offset = 0;
  for (;;) {
    const chunk = await call(b, 'read_attachment_text', { attachment_id: attachmentId, offset, limit: 900 });
    joined += chunk.text;
    if (!chunk.hasMore) break;
    offset += chunk.limit;
  }
  assert.equal(joined, contents, 'paged preview reproduces the file');

  // send_file local-side guards.
  assert.equal((await a.callTool({ name: 'send_file', arguments: { to: 'B', path: 'rel.md' } })).isError, true);
  assert.equal((await a.callTool({ name: 'send_file', arguments: { to: 'B', path: path.join(dir, 'absent.md') } })).isError, true);
  const emptyFile = path.join(dir, 'empty.md');
  fs.writeFileSync(emptyFile, '');
  assert.equal((await a.callTool({ name: 'send_file', arguments: { to: 'B', path: emptyFile } })).isError, true);

  // A file with no accompanying text still lists with the [文件] summary.
  const fileOnly = await call(a, 'send_file', { to: 'B', path: source });
  const summary = (await call(b, 'getmsg', { cursor: sent.id })).messages.find(m => m.id === fileOnly.id);
  assert.equal(summary.summary, '[文件] 排查记录.md');

  // Binary attachments are downloadable but not previewable as text.
  const binPath = path.join(dir, 'blob.bin');
  fs.writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
  const binSent = await call(a, 'send_file', { to: 'B', path: binPath });
  assert.equal((await b.callTool({ name: 'read_attachment_text', arguments: { attachment_id: binSent.attachment.id } })).isError, true);
  const binTarget = path.join(dir, 'blob-copy.bin');
  assert.equal((await call(b, 'save_attachment', { attachment_id: binSent.attachment.id, path: binTarget })).sha256,
    sha256(fs.readFileSync(binPath)));
  assert.deepEqual(fs.readFileSync(binTarget), fs.readFileSync(binPath));
});

// Attachment downloads get 30s because a 10 MiB transfer over a slow LAN link
// can legitimately exceed 10s; text preview keeps the ordinary 10s budget.
test('Attachment downloads tolerate a slow response that text preview times out on', async t => {
  const dir = temp(t);
  const body = Buffer.from('slow but complete');
  const payload = JSON.stringify({
    id: 1, name: 'slow.md', size: body.length, mime: 'text/markdown', sha256: sha256(body),
    createdAt: new Date().toISOString(), data_base64: body.toString('base64'),
  });

  const DELAY_MS = 11_000; // between the 10s text budget and the 30s attachment budget
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    }, DELAY_MS).unref();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));

  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  const target = path.join(dir, 'slow.md');
  const timed = async (call) => { const at = Date.now(); return { result: await call, ms: Date.now() - at }; };
  const [preview, saved] = await Promise.all([
    timed(sdk.callTool({ name: 'read_attachment_text', arguments: { attachment_id: 1 } })),
    timed(sdk.callTool({ name: 'save_attachment', arguments: { attachment_id: 1, path: target } })),
  ]);

  assert.equal(preview.result.isError, true, 'text preview aborts at the 10s budget');
  assert.ok(preview.ms < DELAY_MS, 'preview failed before the server ever replied');
  assert.ok(saved.ms >= DELAY_MS, 'the download really did wait past the 10s text budget');
  assert.ok(!saved.result.isError, saved.result.content?.[0]?.text);
  assert.equal(JSON.parse(saved.result.content[0].text).sha256, sha256(body));
  assert.deepEqual(fs.readFileSync(target), body);
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
