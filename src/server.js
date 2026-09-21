import http from 'node:http';
import { URL } from 'node:url';
import { CONFIG } from './config.js';
import { initDb, syncMembers, insertMessage, getMessageById, queryMessages, markMessagesRead } from './db.js';
import { loadAccessConfig } from './access.js';
import { sendMessageSchema, getMsgQuerySchema, readMessageQuerySchema, markReadSchema } from './validation.js';

function sendJson(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function parseJsonBody(req, maxBytes = CONFIG.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxBytes) {
      const err = new Error(`Payload too large. Maximum size is ${maxBytes} bytes.`);
      err.statusCode = 413;
      return reject(err);
    }

    let received = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        const err = new Error(`Payload too large. Maximum size is ${maxBytes} bytes.`);
        err.statusCode = 413;
        req.destroy();
        return reject(err);
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        return resolve({});
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch {
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

export function createServer(options = {}) {
  // Validate before opening/creating any database. Identity always comes from the socket.
  const access = loadAccessConfig(options.accessConfigPath || process.env.MSG_ACCESS_CONFIG || CONFIG.accessConfig);
  const dbPath = options.dbPath || process.env.MSG_DB_PATH || CONFIG.dbPath;
  const db = options.db || initDb(dbPath);
  try { syncMembers(db, access.members); } catch (err) { db.close(); throw err; }

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;
      const method = req.method.toUpperCase();

      const member = access.identify(req.socket.remoteAddress);
      if (!member) return sendJson(res, 403, { error: 'Forbidden: source IP is not allowed and mapped' });
      req.member = member;

      if (method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, {
          service: 'msg-mcp',
          status: 'ok',
          time: new Date().toISOString(),
          member,
        });
      }

      if (!pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Not Found' });
      }

      // GET /api/peers
      if (method === 'GET' && pathname === '/api/peers') {
        const peers = access.peers;
        return sendJson(res, 200, peers);
      }

      // POST /api/messages
      if (method === 'POST' && pathname === '/api/messages') {
        const body = await parseJsonBody(req);
        const parsed = sendMessageSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const msgData = parsed.data;

        // Check if recipient exists and is active
        if (!access.hasMember(msgData.to)) {
          return sendJson(res, 404, { error: `Recipient "${msgData.to}" is not in current access configuration` });
        }

        // Validate reply_to if specified
        if (msgData.reply_to) {
          const original = getMessageById(db, msgData.reply_to);
          if (!original) {
            return sendJson(res, 400, { error: `Referenced reply_to message ${msgData.reply_to} does not exist` });
          }

          const currentMember = req.member.name;
          const isParticipant = original.from === currentMember || original.to === currentMember;
          if (!isParticipant) {
            return sendJson(res, 403, {
              error: 'Cannot reply to message: current member was neither sender nor recipient of original message',
            });
          }

          // Reply target must be the conversational partner
          const conversationalPartner = original.to === currentMember ? original.from : original.to;
          if (msgData.to !== conversationalPartner) {
            return sendJson(res, 400, {
              error: `Reply recipient must be the conversational partner ("${conversationalPartner}")`,
            });
          }
        }

        const deviceName = (req.headers['x-device-name'] || '').toString().slice(0, CONFIG.maxDeviceNameChars) || null;

        const inserted = insertMessage(db, {
          from: req.member.name,
          to: msgData.to,
          title: msgData.title,
          text: msgData.text,
          project: msgData.project,
          replyTo: msgData.reply_to,
          deviceName,
        });

        return sendJson(res, 201, {
          id: inserted.id,
          createdAt: inserted.createdAt,
        });
      }

      // GET /api/messages (query/getmsg)
      if (method === 'GET' && pathname === '/api/messages') {
        const queryParams = Object.fromEntries(parsedUrl.searchParams.entries());
        const parsed = getMsgQuerySchema.safeParse(queryParams);
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Query parameter validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const { from, unread_only, project, cursor, limit } = parsed.data;

        const result = queryMessages(db, {
          to: req.member.name,
          from,
          unreadOnly: unread_only,
          project,
          cursor,
          limit,
        });

        return sendJson(res, 200, result);
      }

      // GET /api/messages/:id (read message chunk)
      const messageIdMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
      if (method === 'GET' && messageIdMatch) {
        const id = parseInt(messageIdMatch[1], 10);
        const queryParams = Object.fromEntries(parsedUrl.searchParams.entries());
        const parsed = readMessageQuerySchema.safeParse({ id, ...queryParams });
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const msg = getMessageById(db, id);
        if (!msg) {
          return sendJson(res, 404, { error: 'Message not found' });
        }

        // Security check: Only the recipient can read their messages
        if (msg.to !== req.member.name) {
          return sendJson(res, 403, { error: 'Forbidden: access restricted to message recipient' });
        }

        const { offset, limit } = parsed.data;
        const totalLength = msg.text.length;
        const textChunk = msg.text.slice(offset, offset + limit);
        const hasMore = offset + limit < totalLength;

        // Does NOT mark as read automatically
        return sendJson(res, 200, {
          id: msg.id,
          from: msg.from,
          to: msg.to,
          title: msg.title,
          project: msg.project,
          replyTo: msg.replyTo,
          time: msg.time,
          read: msg.readAt !== null,
          totalLength,
          offset,
          limit,
          hasMore,
          text: textChunk,
        });
      }

      // POST /api/messages/mark-read
      if (method === 'POST' && pathname === '/api/messages/mark-read') {
        const body = await parseJsonBody(req);
        const parsed = markReadSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const result = markMessagesRead(db, {
          to: req.member.name,
          ids: parsed.data.ids,
        });

        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      const status = err.statusCode || 500;
      const message = status === 500 ? 'Internal server error' : err.message;
      return sendJson(res, status, { error: message });
    }
  });

  return {
    server,
    db,
    start(port = options.port || CONFIG.port, host = options.host || CONFIG.host) {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          const actualHost = typeof addr === 'object' && addr ? addr.address : host;
          resolve({ host: actualHost, port: actualPort, url: `http://${actualHost}:${actualPort}` });
        });
        server.once('error', reject);
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          try {
            db.close();
          } catch {
            // Already closed
          }
          resolve();
        });
      });
    },
  };
}

// Start standalone server if run directly
const isMain = import.meta.url === `file://${process.argv[1]}` ||
               process.argv[1]?.endsWith('server.js');
if (isMain) {
  const serverInstance = createServer();
  serverInstance.start(CONFIG.port, CONFIG.host).then(({ url }) => {
    console.log(`msg-mcp server listening at ${url}`);
    console.log(`Database path: ${process.env.MSG_DB_PATH || CONFIG.dbPath}`);
  }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });

  const shutdown = async () => {
    console.log('Shutting down server...');
    await serverInstance.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
