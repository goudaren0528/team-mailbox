import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Initializes SQLite database connection with schema and WAL mode.
 */
export function initDb(dbPath) {
  if (dbPath !== ':memory:') {
    const parentDir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);
  try {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS members (
      name TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_name TEXT NOT NULL REFERENCES members(name),
      to_name TEXT NOT NULL REFERENCES members(name),
      title TEXT,
      text TEXT NOT NULL,
      project TEXT,
      reply_to INTEGER REFERENCES messages(id),
      created_at TEXT NOT NULL,
      read_at TEXT,
      device_name TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to_id ON messages(to_name, id);
    CREATE INDEX IF NOT EXISTS idx_messages_to_unread ON messages(to_name, read_at, id);
    DROP TABLE IF EXISTS tokens;
    COMMIT;
  `);

  return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Performs online backup using SQLite's VACUUM INTO.
 */
export function backupDb(db, destinationPath) {
  const resolvedDest = path.resolve(destinationPath);
  const parentDir = path.dirname(resolvedDest);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  if (fs.existsSync(resolvedDest)) {
    throw new Error(`Destination file already exists: ${resolvedDest}`);
  }

  db.prepare('VACUUM INTO ?').run(resolvedDest);
  return resolvedDest;
}

// Historical identities remain for message foreign keys. Access is never read from DB.
export function syncMembers(db, members) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare('INSERT OR IGNORE INTO members (name, display_name, created_at) VALUES (?, ?, ?)');
    for (const { name } of members) insert.run(name, name, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function insertMessage(db, { from, to, title, text, project, replyTo, deviceName }) {
  const now = new Date().toISOString();
  const row = db.prepare(`
    INSERT INTO messages (from_name, to_name, title, text, project, reply_to, created_at, device_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id, created_at as createdAt
  `).get(from, to, title ?? null, text, project ?? null, replyTo ?? null, now, deviceName ?? null);

  return row;
}

export function getMessageById(db, id) {
  return db.prepare(`
    SELECT id, from_name as "from", to_name as "to", title, text, project,
           reply_to as replyTo, created_at as time, read_at as readAt
    FROM messages
    WHERE id = ?
  `).get(id);
}

export function queryMessages(db, { to, from, unreadOnly, project, cursor, limit }) {
  const fetchLimit = limit + 1;
  const unreadFlag = unreadOnly ? 1 : null;
  const cursorVal = typeof cursor === 'number' ? cursor : null;

  const rows = db.prepare(`
    SELECT id, from_name as "from", to_name as "to", title, project, reply_to as replyTo,
           created_at as time, read_at as readAt,
           SUBSTR(text, 1, 80) as summary,
           LENGTH(text) as totalLength
    FROM messages
    WHERE to_name = ?
      AND (? IS NULL OR from_name = ?)
      AND (? IS NULL OR read_at IS NULL)
      AND (? IS NULL OR project = ?)
      AND (? IS NULL OR id > ?)
    ORDER BY id ASC
    LIMIT ?
  `).all(
    to,
    from ?? null, from ?? null,
    unreadFlag,
    project ?? null, project ?? null,
    cursorVal, cursorVal,
    fetchLimit
  );

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = (hasMore && resultRows.length > 0)
    ? resultRows[resultRows.length - 1].id
    : null;

  const messages = resultRows.map(row => ({
    id: row.id,
    from: row.from,
    title: row.title,
    time: row.time,
    read: row.readAt !== null,
    summary: row.totalLength > 80 ? `${row.summary}...` : row.summary,
    project: row.project,
    replyTo: row.replyTo,
  }));

  return { messages, nextCursor, hasMore };
}

export function markMessagesRead(db, { to, ids }) {
  if (!ids || ids.length === 0) {
    return { markedCount: 0, ids: [] };
  }

  const placeholders = ids.map(() => '?').join(',');
  const query = `
    UPDATE messages
    SET read_at = ?
    WHERE to_name = ?
      AND id IN (${placeholders})
      AND read_at IS NULL
    RETURNING id
  `;

  const now = new Date().toISOString();
  const updatedRows = db.prepare(query).all(now, to, ...ids);
  const markedIds = updatedRows.map(r => r.id);

  return { markedCount: markedIds.length, ids: markedIds };
}
