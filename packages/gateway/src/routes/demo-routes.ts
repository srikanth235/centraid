// Scenario-seed routes (issue #290 phase 1) — the owner's "load demo data /
// reset demo data" surface. A blueprint that ships a `seed.js` generator can
// populate a fresh vault with realistic, relative-dated rows; every write
// rides the demo register (owner credential + `demo: {appId}`), so the data
// is receipted, provenance-marked `seed.demo`, invisible to the automation
// plane, and purgeable in one act.
//
//   GET    /centraid/_vault/demo           — per-app status {appId, rows, seedable}
//   POST   /centraid/_vault/demo/<appId>   — run the app's seed.js generator
//   DELETE /centraid/_vault/demo/<appId>   — purge that app's demo rows
//   DELETE /centraid/_vault/demo           — purge every demo row
//
// Generators execute in the same worker sandbox as app handlers (trusted
// local code; the worker is crash + timeout isolation), with `ctx.vault`
// bound to the demo bridge — read/search/invoke/describe only.

import { existsSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { runHandler } from '@centraid/app-engine';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { sendJson } from './route-helpers.js';

const PREFIX = '/centraid/_vault/demo';

export interface DemoRouteDeps {
  /** Live code root (`<main worktree>/apps`) of the ACTIVE vault's store. */
  codeAppsDir(): string;
}

/** Apps whose live code ships a seed.js scenario generator. */
function seedableApps(codeAppsDir: string): Set<string> {
  const seedable = new Set<string>();
  let entries: string[] = [];
  try {
    entries = readdirSync(codeAppsDir);
  } catch {
    return seedable;
  }
  for (const entry of entries) {
    if (existsSync(path.join(codeAppsDir, entry, 'seed.js'))) seedable.add(entry);
  }
  return seedable;
}

export function makeDemoRouteHandler(vaults: VaultRegistry, deps: DemoRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const appId = rest === '' ? null : decodeURIComponent(rest);
    const method = req.method ?? 'GET';
    const plane = vaults.active();

    if (method === 'GET' && appId === null) {
      const rowsByApp = new Map(plane.demoStatus().map((s) => [s.appId, s.rows]));
      const seedable = seedableApps(deps.codeAppsDir());
      const apps = [...new Set([...rowsByApp.keys(), ...seedable])].sort().map((id) => ({
        appId: id,
        rows: rowsByApp.get(id) ?? 0,
        seedable: seedable.has(id),
      }));
      sendJson(res, 200, { apps });
      return true;
    }

    if (method === 'POST' && appId !== null) {
      const seedFile = path.join(deps.codeAppsDir(), appId, 'seed.js');
      if (!existsSync(seedFile)) {
        sendJson(res, 404, { error: `app "${appId}" ships no seed.js scenario` });
        return true;
      }
      const outcome = await runHandler({
        app: { id: appId, dir: path.join(vaults.activeWorkspace().appsDir, appId) },
        handlerFile: seedFile,
        handlerKind: 'action',
        // Deterministic-by-default: generators derive their randomness from
        // `input.seed` and their dates from `input.now`, so the same load
        // reproduces the same scenario (test fixtures ride this too).
        args: { input: { seed: 1, now: new Date().toISOString() } },
        timeoutMs: 60_000,
        vault: vaults.demoBridgeFor(appId),
      });
      if (!outcome.ok) {
        sendJson(res, 500, { error: outcome.error ?? 'seed generator failed', logs: outcome.logs });
        return true;
      }
      const status = plane.demoStatus().find((s) => s.appId === appId);
      sendJson(res, 200, { ok: true, result: outcome.value ?? null, rows: status?.rows ?? 0 });
      return true;
    }

    if (method === 'DELETE') {
      const result = plane.purgeDemo(appId ?? undefined);
      sendJson(res, 200, result);
      return true;
    }

    sendJson(res, 405, { error: `unsupported ${method} on ${url.pathname}` });
    return true;
  };
}
