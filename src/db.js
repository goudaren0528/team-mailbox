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

    -- Incremental migration only: messages is never rebuilt, so historical rows,
    -- ids, read state and reply links survive an upgrade untouched. BLOB storage
    -- keeps "admin backup" (VACUUM INTO) a single self-contained file.
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT,
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

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

export function insertMessage(db, { from, to, title, text, project, deviceName, attachment }) {
  const now = new Date().toISOString();
  // reply_to is a retired feature: the column stays for historical rows, but every
  // new message writes NULL. Dropping it would require rebuilding messages.
  const insert = () => db.prepare(`
    INSERT INTO messages (from_name, to_name, title, text, project, reply_to, created_at, device_name)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    RETURNING id, created_at as createdAt
  `).get(from, to, title ?? null, text, project ?? null, now, deviceName ?? null);

  if (!attachment) return insert();

  // Message and its single attachment must land atomically: a message row that
  // claims a file but has none would be unreadable and unrecoverable.
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = insert();
    const saved = db.prepare(`
      INSERT INTO attachments (message_id, name, size, mime, sha256, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id, name, size, mime, sha256
    `).get(row.id, attachment.name, attachment.data.length, attachment.mime ?? null,
      attachment.sha256, attachment.data, now);
    db.exec('COMMIT');
    return { ...row, attachment: saved };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const ATTACHMENT_META_SELECT = `
  a.id as attachmentId, a.name as attachmentName, a.size as attachmentSize,
  a.mime as attachmentMime, a.sha256 as attachmentSha256
`;

function attachmentFromRow(row) {
  if (!row || row.attachmentId === null || row.attachmentId === undefined) return null;
  return {
    id: row.attachmentId,
    name: row.attachmentName,
    size: row.attachmentSize,
    mime: row.attachmentMime,
    sha256: row.attachmentSha256,
  };
}

export function getMessageById(db, id) {
  const row = db.prepare(`
    SELECT m.id, m.from_name as "from", m.to_name as "to", m.title, m.text, m.project,
           m.created_at as time, m.read_at as readAt,
           ${ATTACHMENT_META_SELECT}
    FROM messages m
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.id = ?
  `).get(id);
  if (!row) return undefined;
  return {
    id: row.id,
    from: row.from,
    to: row.to,
    title: row.title,
    text: row.text,
    project: row.project,
    time: row.time,
    readAt: row.readAt,
    attachment: attachmentFromRow(row),
  };
}

// Returns attachment metadata plus recipient, so callers can authorize before
// exposing any field. Never leaks whether a foreign attachment exists.
export function getAttachmentById(db, id) {
  const row = db.prepare(`
    SELECT a.id, a.message_id as messageId, a.name, a.size, a.mime, a.sha256, a.data,
           a.created_at as createdAt, m.to_name as "to", m.from_name as "from"
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE a.id = ?
  `).get(id);
  return row;
}

export function queryMessages(db, { to, from, unreadOnly, project, cursor, limit }) {
  const fetchLimit = limit + 1;
  const unreadFlag = unreadOnly ? 1 : null;
  const cursorVal = typeof cursor === 'number' ? cursor : null;

  const rows = db.prepare(`
    SELECT m.id, m.from_name as "from", m.to_name as "to", m.title, m.project,
           m.created_at as time, m.read_at as readAt,
           SUBSTR(m.text, 1, 80) as summary,
           LENGTH(m.text) as totalLength,
           ${ATTACHMENT_META_SELECT}
    FROM messages m
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.to_name = ?
      AND (? IS NULL OR m.from_name = ?)
      AND (? IS NULL OR m.read_at IS NULL)
      AND (? IS NULL OR m.project = ?)
      AND (? IS NULL OR m.id > ?)
    ORDER BY m.id ASC
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

  const messages = resultRows.map(row => {
    const attachment = attachmentFromRow(row);
    const summary = row.totalLength > 80 ? `${row.summary}...` : row.summary;
    return {
      id: row.id,
      from: row.from,
      title: row.title,
      time: row.time,
      read: row.readAt !== null,
      // File-only messages store an empty text; show the file name instead of a blank row.
      summary: summary === '' && attachment ? `[文件] ${attachment.name}` : summary,
      project: row.project,
      attachment,
    };
  });

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
