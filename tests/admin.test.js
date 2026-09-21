import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runAdmin } from '../src/admin.js';
import { initDb, syncMembers, insertMessage } from '../src/db.js';
import { checkDatabase } from '../src/doctor.js';
import { temp, accessConfig } from './helpers.js';

test('Admin validates/lists current config without DB, rejects removed commands; VACUUM INTO existing DB', t => {
  const dir = temp(t); const config = path.join(dir, 'access.json'); const dbPath = path.join(dir, 'db.sqlite');
  fs.writeFileSync(config, JSON.stringify(accessConfig));
  const oldConfig = process.env.MSG_ACCESS_CONFIG, oldDb = process.env.MSG_DB_PATH;
  process.env.MSG_ACCESS_CONFIG = config; process.env.MSG_DB_PATH = dbPath;
  try {
    for (const command of ['--help', 'validate-config', 'list-members']) assert.equal(runAdmin(['node', 'admin', command]), 0);
    for (const command of ['add-member', 'rotate-token', 'revoke-member', 'wrong']) assert.equal(runAdmin(['node', 'admin', command]), 1);
    assert.equal(fs.existsSync(dbPath), false);
    assert.equal(runAdmin(['node', 'admin', 'backup', path.join(dir, 'missing-backup.sqlite')]), 1);
    assert.equal(fs.existsSync(dbPath), false);
    const db = initDb(dbPath);
    try {
      syncMembers(db, accessConfig.members);
      insertMessage(db, { from: 'A', to: 'B', text: 'persisted', title: null, project: null, deviceName: null });
      const backup = path.join(dir, 'backup.sqlite');
      assert.equal(runAdmin(['node', 'admin', 'backup', backup]), 0);
      assert.equal(checkDatabase(backup), 1);
      assert.equal(runAdmin(['node', 'admin', 'backup', backup]), 1);
    } finally { db.close(); }
  } finally {
    if (oldConfig === undefined) delete process.env.MSG_ACCESS_CONFIG; else process.env.MSG_ACCESS_CONFIG = oldConfig;
    if (oldDb === undefined) delete process.env.MSG_DB_PATH; else process.env.MSG_DB_PATH = oldDb;
  }
});

test('Legacy DB migration preserves messages, ids, read/reply metadata and historical members; drops obsolete credentials', t => {
  const dir = temp(t); const file = path.join(dir, 'legacy.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE members(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE tokens(token_hash TEXT PRIMARY KEY,member_name TEXT REFERENCES members(name),created_at TEXT,revoked_at TEXT,last_used_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,from_name TEXT NOT NULL REFERENCES members(name),to_name TEXT NOT NULL REFERENCES members(name),title TEXT,text TEXT NOT NULL,project TEXT,reply_to INTEGER REFERENCES messages(id),created_at TEXT NOT NULL,read_at TEXT,device_name TEXT);
    INSERT INTO members VALUES('A','old A','old',NULL),('B','old B','old','revoked'),('History','history','old',NULL);
    INSERT INTO tokens VALUES('obsolete','A','old',NULL,NULL);
    INSERT INTO messages VALUES(41,'A','B','title','original','demo',NULL,'old','read','desk');
    INSERT INTO messages VALUES(42,'B','A',NULL,'reply',NULL,41,'old',NULL,NULL);`);
  const rows = old.prepare('SELECT * FROM messages').all(); old.close();
  const migrated = initDb(file);
  try {
    syncMembers(migrated, accessConfig.members);
    assert.deepEqual(migrated.prepare('SELECT * FROM messages').all(), rows);
    assert.equal(migrated.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='tokens'").get().n, 0);
    assert.ok(migrated.prepare("SELECT name FROM members WHERE name='History'").get());
    assert.ok(insertMessage(migrated, { from: 'A', to: 'B', text: 'next' }).id > 42);
    assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { migrated.close(); }
});
