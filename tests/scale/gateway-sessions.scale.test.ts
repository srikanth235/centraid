/**
 * Gateway multi-session headroom (#496 PE1).
 * Spins many concurrent session-shaped HTTP probes against a real serve().
 */
import { tempDir } from '@centraid/test-kit/temp-dir';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { serve, type GatewayServeHandle } from '../../packages/gateway/src/serve/serve.js';

const OWNER = 'tests/scale/gateway-sessions.scale.test.ts';
const SESSIONS = 40;
const BUDGET_MS = 15_000;

let dataDir: string;
let handle: GatewayServeHandle;

beforeEach(async () => {
  dataDir = await tempDir(`gw-scale-${crypto.randomUUID()}-`);
  handle = await serve({
    paths: { vaultDir: path.join(dataDir, 'vault'), prefsFile: path.join(dataDir, 'prefs.json') },
    token: 'scale-admin-token',
  });
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('concurrent session probes complete under headroom budget', async () => {
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: SESSIONS }, async () => {
      const res = await fetch(`${handle.url}/centraid/_apps`, {
        headers: { Authorization: 'Bearer scale-admin-token' },
      });
      return res.status;
    }),
  );
  const durationMs = performance.now() - started;
  const ok = results.every((s) => s !== 401 && s !== 403 && s < 500);
  const passed = ok && durationMs < BUDGET_MS;
  await recordQualityResult({
    lane: 'scale',
    owner: OWNER,
    name: `Gateway ${SESSIONS} concurrent session probes`,
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'wall clock', value: durationMs, unit: 'ms', budget: BUDGET_MS },
      { name: 'sessions', value: SESSIONS, unit: 'count' },
    ],
  });
  expect(ok).toBe(true);
  expect(durationMs).toBeLessThan(BUDGET_MS);
});
