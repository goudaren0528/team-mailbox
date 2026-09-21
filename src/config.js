import path from 'node:path';

// Original (pre-base64) size ceiling for a single attachment. Administrators may
// only lower it; anything outside (0, DEFAULT] falls back to the default so a
// typo can never raise the ceiling above what the request body limit allows.
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB

function resolveMaxAttachmentBytes() {
  const raw = process.env.MSG_MAX_ATTACHMENT_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_ATTACHMENT_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_ATTACHMENT_BYTES) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  return value;
}

export const CONFIG = {
  host: process.env.MSG_HOST || '127.0.0.1',
  port: parseInt(process.env.MSG_PORT || '8787', 10),
  dbPath: process.env.MSG_DB_PATH || path.resolve('./data/msg.sqlite'),
  serverUrl: process.env.MSG_SERVER_URL || 'http://127.0.0.1:8787',
  accessConfig: process.env.MSG_ACCESS_CONFIG || path.resolve('./access.json'),
  deviceName: process.env.MSG_DEVICE_NAME || '',
  downloadDir: process.env.MSG_DOWNLOAD_DIR || '', // Optional existing absolute override; otherwise package-root downloads/.
  maxBodyBytes: 64 * 1024, // 64 KB
  maxTextChars: 32_000,
  maxTitleChars: 100,
  maxProjectChars: 50,
  maxDeviceNameChars: 64,
  maxNameChars: 32,
  maxDisplayNameChars: 64,
  defaultPageLimit: 20,
  maxPageLimit: 100,
  defaultReadChunkLimit: 2000,
  maxReadChunkLimit: 4000,
  requestTimeoutMs: 10_000,
  // Attachment transfer: base64 inflates ~33%, so a 10 MiB file needs ~13.4 MiB
  // plus JSON overhead. Only POST /api/messages uses this larger ceiling.
  maxAttachmentBytes: resolveMaxAttachmentBytes(),
  maxAttachmentBodyBytes: 16 * 1024 * 1024, // 16 MiB
  maxAttachmentNameChars: 200,
  maxAttachmentMimeChars: 100,
  maxAttachmentPreviewBytes: 1024 * 1024, // 1 MiB
  attachmentTimeoutMs: 30_000,
  textAttachmentExtensions: Object.freeze([
    '.md', '.txt', '.log', '.json', '.csv', '.yml', '.yaml',
    '.xml', '.ini', '.conf', '.sql', '.js', '.ts', '.py', '.sh', '.ps1',
  ]),
};
