import path from 'node:path';

export const CONFIG = {
  host: process.env.MSG_HOST || '127.0.0.1',
  port: parseInt(process.env.MSG_PORT || '8787', 10),
  dbPath: process.env.MSG_DB_PATH || path.resolve('./data/msg.sqlite'),
  serverUrl: process.env.MSG_SERVER_URL || 'http://127.0.0.1:8787',
  accessConfig: process.env.MSG_ACCESS_CONFIG || path.resolve('./access.json'),
  deviceName: process.env.MSG_DEVICE_NAME || '',
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
};
