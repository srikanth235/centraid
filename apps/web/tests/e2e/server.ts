import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { serve } from '../../../../packages/gateway/dist/serve/serve.js';

const dataDir = await fs.mkdtemp(
  path.join(os.tmpdir(), `centraid-web-e2e-${crypto.randomUUID()}-`),
);
const handle = await serve({
  host: '127.0.0.1',
  port: 48765,
  token: 'centraid-web-e2e-token',
  paths: {
    vaultDir: path.join(dataDir, 'vault'),
    prefsFile: path.join(dataDir, 'prefs.json'),
  },
  web: {
    rootDir: path.resolve('dist'),
    host: '127.0.0.1',
    port: 4173,
  },
});

const store = await handle.appsStore();
const session = await store.openSession('seed-web-e2e');
const appDir = path.join(session.worktreePath, 'apps', 'web-e2e');
await fs.mkdir(path.join(appDir, 'queries'), { recursive: true });
await fs.writeFile(
  path.join(appDir, 'app.json'),
  JSON.stringify({
    manifestVersion: 1,
    id: 'web-e2e',
    name: 'Web E2E App',
    description: 'A browser-isolation fixture.',
    version: '0.1.0',
    tables: [],
    actions: [],
    queries: [
      {
        name: 'ping',
        description: 'Returns a stable browser smoke result.',
        input: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }),
);
await fs.writeFile(
  path.join(appDir, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>Web E2E App</title></head><body><h1>Web E2E App</h1><p id="ready">generated app ready</p></body></html>',
);
await fs.writeFile(
  path.join(appDir, 'queries', 'ping.js'),
  "export default async () => ({ pong: true, surface: 'web' });\n",
);
await store.publish({ sessionId: 'seed-web-e2e', appId: 'web-e2e', message: 'seed web e2e' });
await store.closeSession('seed-web-e2e');
await handle.syncApps();

async function close(): Promise<void> {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}

process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await new Promise(() => undefined);
