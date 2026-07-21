import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Template catalog over HTTP (issue #141). The gateway owns the bundled
 * @centraid/blueprints catalog and serves its display metadata at
 * `GET /centraid/_templates`, so the renderer reads it directly instead of
 * through a desktop IPC. We boot serve() and assert the route returns the
 * stripped metadata rows (no `files`/`source`), behind the bearer check.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serve, type GatewayServeHandle } from '../serve/serve.ts';
import { makeTemplatesRouteHandler } from './templates-routes.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, 'vault'),
    prefsFile: path.join(dir, 'prefs.json'),
  };
}

beforeEach(async () => {
  dataDir = await tempDir(`gateway-templates-${crypto.randomUUID()}-`);
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('GET /centraid/_templates returns stripped bundled metadata behind auth', async () => {
  handle = await serve({ paths: pathsUnder(dataDir) });

  // No bearer → 401.
  const unauth = await fetch(`${handle.url}/centraid/_templates`);
  expect(unauth.status).toBe(401);

  const res = await fetch(`${handle.url}/centraid/_templates`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  expect(res.status).toBe(200);
  const templates = (await res.json()) as Array<Record<string, unknown>>;
  expect(Array.isArray(templates) && templates.length > 0).toBeTruthy();

  for (const t of templates) {
    // Display metadata present…
    for (const key of ['id', 'name', 'desc', 'colorKey', 'iconKey', 'version']) {
      expect(key in t).toBeTruthy();
    }
    // …and the bulky resolver internals stripped.
    expect(!('files' in t)).toBeTruthy();
    expect(!('source' in t)).toBeTruthy();
  }

  // `kind` must cross the wire — the renderer's automation gallery filters on
  // it, so dropping it left that surface permanently empty (regression guard).
  const automations = templates.filter((t) => t.kind === 'automation');
  expect(automations.length).toBeGreaterThan(0);
  for (const t of automations) {
    // The automation card renders from these display fields.
    for (const key of ['emoji', 'category', 'triggerKind', 'triggerLabel', 'integrations']) {
      expect(key in t).toBeTruthy();
    }
  }
  // Automations declare access on their own manifest, not the app-kind vault
  // block — so they never carry `vault` here.
  for (const t of automations) {
    expect('vault' in t).toBeFalsy();
  }

  // Issue #434: an app-kind template with a declared vault block carries it,
  // so the Discover install/consent sheet can render the requested access.
  const photos = templates.find((t) => t.id === 'photos');
  expect(photos).toBeTruthy();
  const vault = photos?.vault as
    | { why?: string; scopes?: Array<{ schema: string; table?: string; verbs: string }> }
    | undefined;
  expect(vault).toBeTruthy();
  expect(typeof vault?.why).toBe('string');
  expect(Array.isArray(vault?.scopes) && (vault?.scopes?.length ?? 0) > 0).toBeTruthy();
  expect(
    vault?.scopes?.every((s) => typeof s.schema === 'string' && typeof s.verbs === 'string'),
  ).toBeTruthy();
});

// Issue #141, Phase 5: the gateway owns the remote template *refresh* too —
// the fetch the desktop main process used to run before it dropped
// `@centraid/blueprints`. Constructing the handler with both a cache dir
// and a remote URL kicks a one-time best-effort fetch; without the URL it
// stays quiet.
test('handler refreshes the cache from the remote URL on construction', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(null, { status: 404 }); // manifest miss → fetch bails, never throws
  }) as typeof fetch;

  makeTemplatesRouteHandler({
    cacheDir: path.join(dataDir, 'tmpl-cache'),
    remoteTemplatesUrl: 'https://templates.example.test',
    fetchImpl,
  });
  // Fire-and-forget — poll until the remote fetch lands (no fixed sleep).
  await vi.waitFor(() => {
    expect(calls.some((u) => u.startsWith('https://templates.example.test'))).toBeTruthy();
  });
});

test('handler does not fetch when no remote URL is configured', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  makeTemplatesRouteHandler({ cacheDir: path.join(dataDir, 'tmpl-cache'), fetchImpl });
  // Allow a microtask turn for any accidental fire-and-forget, then assert quiet.
  await Promise.resolve();
  await Promise.resolve();
  expect(calls.length).toBe(0);
});
