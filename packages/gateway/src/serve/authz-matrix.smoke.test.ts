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
    name: 'no bearer → 401 on health (detail is host-auth gated)',
    route: '/centraid/_gateway/health',
    expect: 401,
  },
  {
    name: 'admin bearer → 200 on health',
    route: '/centraid/_gateway/health',
    authorization: `Bearer ${ADMIN}`,
    expect: 200,
  },
  {
    name: 'no bearer → 401 on vault plane',
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
    name: 'admin bearer reaches apps (not 401/403)',
    route: '/centraid/_apps',
    authorization: `Bearer ${ADMIN}`,
    expect: (s) => s !== 401 && s !== 403 && s < 500,
  },
  {
    name: 'admin bearer on vault plane is not 401 (auth accepted)',
    route: '/_centraid/vault/sql',
    method: 'POST',
    authorization: `Bearer ${ADMIN}`,
    // Auth must succeed; body may still 4xx for missing SQL — never 401/403/5xx.
    expect: (s) => s !== 401 && s !== 403 && s < 500,
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
