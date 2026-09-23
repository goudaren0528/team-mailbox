import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaults = {
  root: 'D:/team-mailbox', node: 'C:/nvm4w/nodejs/node.exe',
  db: 'D:/team-mailbox/data/msg.sqlite', access: 'D:/team-mailbox/access.json',
  host: '0.0.0.0', port: 18787,
};

export async function run(argv = process.argv.slice(2)) {
  const options = { ...defaults };
  const allowed = new Set(['root', 'node', 'db', 'access', 'host', 'port']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Invalid startup arguments');
    options[key] = argv[i + 1];
  }
  if (!Number.isInteger(Number(options.port)) || Number(options.port) < 1 || Number(options.port) > 65535) throw Error('Invalid port');
  for (const key of ['root', 'node', 'db', 'access']) if (!path.isAbsolute(options[key])) throw Error(`Absolute ${key} path required`);
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(options.node).toLowerCase()) throw Error('Unexpected Node executable');
  if (!fs.statSync(options.root).isDirectory() || !fs.statSync(options.db).isFile() || fs.statSync(options.db).size === 0 || !fs.statSync(options.access).isFile()) throw Error('Missing or empty existing center DB/access');
  const entry = path.join(options.root, 'src', 'server.js');
  if (!fs.statSync(entry).isFile()) throw Error('Center entry missing');
  const logDir = path.join(options.root, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'server.stdout.log'), 'a');
  const err = fs.openSync(path.join(logDir, 'server.stderr.log'), 'a');
  const write = (fd, parts) => fs.writeSync(fd, `${parts.map(part => typeof part === 'string' ? part : String(part)).join(' ')}\n`);
  const priorLog = console.log;
  const priorError = console.error;
  console.log = (...parts) => write(out, parts);
  console.error = (...parts) => write(err, parts);
  let app;
  try {
    // Do not import until the existing DB has been verified; createServer initializes schema.
    const { createServer } = await import(pathToFileURL(entry).href);
    app = createServer({ dbPath: options.db, accessConfigPath: options.access });
    await app.start(Number(options.port), options.host);
    console.log('team-mailbox foreground center started');
    let shuttingDown = false;
    const stop = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { await app.close(); process.exitCode = 0; }
      catch { console.error('Center shutdown failed'); process.exitCode = 1; }
      finally { fs.closeSync(out); fs.closeSync(err); }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    // Never claim an occupied port, kill its owner, or print access/DB content.
    console.error('Center foreground startup failed (check DB/access/port and stderr diagnostics)');
    if (app) { try { app.db.close(); } catch {} }
    fs.closeSync(out);
    fs.closeSync(err);
    throw Error('Center foreground startup failed');
  } finally {
    console.log = priorLog;
    console.error = priorError;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  run().catch(() => { process.exitCode = 1; });
}
