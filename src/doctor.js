#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { CONFIG } from './config.js';
import { apiUrl } from './url.js';
import { memberNameSchema } from './validation.js';

const healthSchema = z.object({
  service: z.literal('team-mailbox'), status: z.literal('ok'), time: z.string().datetime(),
  member: z.object({ name: memberNameSchema, displayName: z.string().min(1) }).strict(),
}).strict();

function parseArgs(argv) {
  const options = { checkDb: false, checkServer: true,
    dbPath: process.env.MSG_DB_PATH || CONFIG.dbPath,
    serverUrl: process.env.MSG_SERVER_URL || CONFIG.serverUrl };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--server-url' || arg === '--db-path') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--server-url') options.serverUrl = args[++i];
      else { options.dbPath = args[++i]; options.checkDb = true; }
    } else if (arg === '--check-db') options.checkDb = true;
    else if (arg === '--skip-server') options.checkServer = false;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.checkDb && !options.checkServer) throw new Error('No checks selected');
  return options;
}

export function checkDatabase(dbPath) {
  if (dbPath === ':memory:') throw new Error('An existing database file is required');
  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Database integrity failed');
    // Preparing these statements also verifies required columns, not just table names.
    db.prepare('SELECT name, display_name, created_at, revoked_at FROM members LIMIT 0').all();
    db.prepare('SELECT id, from_name, to_name, title, text, project, reply_to, created_at, read_at, device_name FROM messages LIMIT 0').all();
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed');
    return db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
  } finally { db?.close(); }
}

export async function runDoctor(argv = process.argv) {
  let options;
  try { options = parseArgs(argv); } catch (err) { console.error(`[FAIL] ${err.message}`); return 1; }
  if (options.help) {
    console.log('Usage: npm run doctor -- [--server-url URL] [--check-db | --db-path FILE] [--skip-server]\nDefault: remote health/identity only; DB checks explicitly open an existing file read-only.');
    return 0;
  }
  let failures = 0;
  console.log(`Scope: Node; remote=${options.checkServer}; existing DB read-only=${options.checkDb}`);
  if (Number(process.versions.node.split('.')[0]) !== 24) { console.error('[FAIL] Requires Node 24'); failures++; }
  else console.log('[PASS] Node 24');
  if (options.checkDb) {
    try { console.log(`[PASS] DB ${path.resolve(options.dbPath)}: ${checkDatabase(options.dbPath)} messages`); }
    catch (err) { console.error(`[FAIL] DB: ${err.message}`); failures++; }
  }
  if (options.checkServer) {
    try {
      const url = apiUrl(options.serverUrl, 'health');
      console.log(`Remote health: ${url.href}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const health = healthSchema.parse(await res.json());
      console.log(`[PASS] team-mailbox healthy; current member: ${health.member.name}`);
    } catch (err) { console.error(`[FAIL] Remote: ${err.message}`); failures++; }
  }
  console.log(failures ? 'Diagnostics FAILED' : 'Selected diagnostics PASSED (not a full messaging test)');
  return failures ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runDoctor();
