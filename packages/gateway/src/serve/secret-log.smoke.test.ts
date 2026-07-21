/**
 * Secret-in-logs / token leakage smoke (#496 G3).
 * Drives a real `serve()` instance and asserts error/auth paths never echo
 * bearer tokens or seal-key material back in response bodies.
 */
import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, expect, test } from 'vitest';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GatewayPaths } from '../paths.js';
import { serve, type GatewayServeHandle } from './serve.js';

const ADMIN = 'secret-log-admin-token-do-not-echo';
const FAKE_SEAL = 'f'.repeat(64);

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return { vaultDir: path.join(dir, 'vault'), prefsFile: path.join(dir, 'prefs.json') };
}

beforeEach(async () => {
  dataDir = await tempDir(`secret-log-${crypto.randomUUID()}-`);
  handle = await serve({ paths: pathsUnder(dataDir), token: ADMIN });
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('401 body does not echo a presented wrong bearer token', async () => {
  const wrong = 'wrong-bearer-should-never-appear-in-body-xyz';
  const res = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${wrong}` },
  });
  expect(res.status).toBe(401);
  const body = await res.text();
  expect(body).not.toContain(wrong);
  expect(body).not.toContain(ADMIN);
});

test('admin success path does not leak the bearer in JSON bodies', async () => {
  const res = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  // Any non-5xx is fine; body must not contain the raw token.
  expect(res.status).toBeLessThan(500);
  const body = await res.text();
  expect(body).not.toContain(ADMIN);
  expect(body).not.toMatch(/Bearer\s+secret-log-admin/i);
});

test('error path with seal-key-shaped payload does not reflect raw key material', async () => {
  // POST a nonsense body that includes seal-key-looking content; the server
  // must not reflect it in an error message.
  const res = await fetch(`${handle.url}/_centraid/vault/sql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sql: 'SELECT 1', seal_key: FAKE_SEAL }),
  });
  const body = await res.text();
  // Even on 4xx/2xx, the response must not dump the seal key back.
  expect(body.includes(FAKE_SEAL)).toBe(false);
});
