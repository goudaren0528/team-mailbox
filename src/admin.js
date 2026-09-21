#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.js';
import { loadAccessConfig } from './access.js';
import { backupDb } from './db.js';

export function runAdmin(argv = process.argv) {
  const [command, ...args] = argv.slice(2);
  let db;
  try {
    if (!command || command === '--help' || command === '-h') {
      if (args.length) throw new Error('Unexpected arguments');
      console.log('Usage: npm run admin -- validate-config | list-members | backup <new-file>\nEnvironment: MSG_ACCESS_CONFIG (./access.json), MSG_DB_PATH (./data/msg.sqlite)');
      return 0;
    }
    if (command === 'validate-config' || command === 'list-members') {
      if (args.length) throw new Error('Unexpected arguments');
      const access = loadAccessConfig(process.env.MSG_ACCESS_CONFIG || CONFIG.accessConfig);
      if (command === 'list-members') console.table(access.members.map(m => ({ name: m.name, ips: m.ips.join(', ') })));
      else console.log(`Access configuration valid: ${access.members.length} members`);
    } else if (command === 'backup' && args.length === 1) {
      // Open existing DB only; backup must not initialize or migrate the source.
      db = new DatabaseSync(process.env.MSG_DB_PATH || CONFIG.dbPath, { readOnly: true });
      console.log(`VACUUM INTO backup: ${backupDb(db, args[0])}`);
    } else throw new Error('Unknown command or invalid arguments; use --help');
    return 0;
  } catch (err) {
    console.error(`Admin error: ${err.message}`);
    return 1;
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runAdmin();
