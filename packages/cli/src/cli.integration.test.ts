/**
 * Product CLI entry against a real HTTP gateway surface (issue #504).
 * Drives `main()` — the shipped bin path — not a reimplementation of client helpers.
 */
import { afterEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import { GATEWAY_SCHEMA_EPOCH, GATEWAY_VERSION, ROUTES } from '@centraid/protocol';
import { main } from './cli.ts';

let server: http.Server | undefined;
let baseUrl = '';
const token = 'integration-cli-token';

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  server = undefined;
});

async function startGateway(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers.authorization ?? '';
    if (url.pathname === ROUTES.gatewayInfo) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          version: GATEWAY_VERSION,
          schemaEpoch: GATEWAY_SCHEMA_EPOCH,
          instanceId: 'cli-int-1',
          capabilities: {
            webSessions: true,
            devicePairing: true,
            tunnel: true,
            backupWal: true,
          },
        }),
      );
      return;
    }
    if (url.pathname === ROUTES.gatewayHealth) {
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', components: [] }));
      return;
    }
    if (url.pathname === ROUTES.appsList) {
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'notes' }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no address'));
        return;
      }
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

async function runCli(argv: string[]): Promise<{ stdout: string; code: number | undefined }> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const errWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let code: number | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c ?? 0;
    throw new Error(`__exit_${code}`);
  }) as never);
  try {
    await main(argv);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('__exit_')) throw err;
  } finally {
    write.mockRestore();
    errWrite.mockRestore();
    exit.mockRestore();
  }
  return { stdout: chunks.join(''), code };
}

test('centraid status/health/list via main() against a live HTTP gateway', async () => {
  await startGateway();

  const status = await runCli(['status', '--url', baseUrl, '--token', token, '--json']);
  expect(status.code).toBeUndefined(); // main returns without process.exit on success
  const statusBody = JSON.parse(status.stdout) as {
    ok: boolean;
    version: string;
    schemaEpoch: number;
    capabilities: { webSessions: boolean };
  };
  expect(statusBody.ok).toBe(true);
  expect(statusBody.version).toBe(GATEWAY_VERSION);
  expect(statusBody.schemaEpoch).toBe(GATEWAY_SCHEMA_EPOCH);
  expect(statusBody.capabilities.webSessions).toBe(true);

  const health = await runCli(['health', '--url', baseUrl, '--token', token, '--json']);
  expect(JSON.parse(health.stdout)).toMatchObject({ status: 'ok' });

  const list = await runCli(['list', '--url', baseUrl, '--token', token, '--json']);
  expect(JSON.parse(list.stdout)).toEqual([{ id: 'notes' }]);
});
