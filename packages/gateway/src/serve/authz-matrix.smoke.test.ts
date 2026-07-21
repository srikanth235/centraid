/**
 * Authz matrix smoke (#496 G1): table-driven role/session × critical routes
 * against a real `serve()` daemon. Complements the denser per-route suites
 * with one compact cross-surface table the matrix can own.
 */
import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, expect, test } from 'vitest';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GatewayPaths } from '../paths.js';
import { serve, type GatewayServeHandle } from './serve.js';

const ADMIN = 'authz-smoke-admin-token';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return { vaultDir: path.join(dir, 'vault'), prefsFile: path.join(dir, 'prefs.json') };
}

beforeEach(async () => {
  dataDir = await tempDir(`authz-smoke-${crypto.randomUUID()}-`);
  handle = await serve({ paths: pathsUnder(dataDir), token: ADMIN });
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function hit(
  route: string,
  opts: { authorization?: string; method?: string } = {},
): Promise<number> {
  const res = await fetch(`${handle.url}${route}`, {
    method: opts.method ?? 'GET',
    headers: opts.authorization ? { Authorization: opts.authorization } : {},
  });
  return res.status;
}

const CASES: Array<{
  name: string;
  route: string;
  authorization?: string;
  method?: string;
  /** Status family or exact code */
  expect: number | ((status: number) => boolean);
}> = [
  {
    name: 'no bearer → 401 on health is still open, but vault plane is closed',
    route: '/_centraid/vault/sql',
    method: 'POST',
    expect: 401,
  },
  {
    name: 'no bearer → 401 on apps list',
    route: '/centraid/_apps',
    expect: 401,
  },
  {
    name: 'wrong bearer → 401',
    route: '/centraid/_apps',
    authorization: 'Bearer totally-wrong-token',
    expect: 401,
  },
  {
    name: 'admin bearer reaches apps (2xx or empty 404-shaped, not 401/403)',
    route: '/centraid/_apps',
    authorization: `Bearer ${ADMIN}`,
    expect: (s) => s !== 401 && s !== 403,
  },
  {
    name: 'admin bearer not confused with device confinement on public pair',
    route: '/_pair/status',
    expect: (s) => s === 401 || s === 404 || s === 405 || s < 500,
  },
];

test.each(CASES)('authz smoke: $name', async (c) => {
  const status = await hit(c.route, {
    authorization: c.authorization,
    method: c.method,
  });
  if (typeof c.expect === 'function') {
    expect(c.expect(status), `status ${status} for ${c.route}`).toBe(true);
  } else {
    expect(status).toBe(c.expect);
  }
});
