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

import { existsSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { runHandler } from "@centraid/server/engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { sendJson } from "./route-helpers.js";

const PREFIX = "/centraid/_vault/demo";
const TIME_ENGINE_MODULE_URL = import.meta.resolve("@centraid/core/time");

export interface DemoRouteDeps {
  /** Live code root (`<main worktree>/apps`) of the ACTIVE vault's store. */
  codeAppsDir: () => string;
  /**
   * Directories a BUNDLED app serves from, by id — the shipped
   * `@centraid/blueprints` trees, which are not under `codeAppsDir` at all.
   *
   * Without this the whole demo plane was dead for exactly the apps it was
   * written for. Issue #434 made a bundled install serve IN PLACE (no per-vault
   * code copy), and #708 made every first-party app installed by default — so
   * `GET /demo` scanned the git store, found nothing, and answered `{apps:[]}`
   * while `POST /demo/tasks` 404'd, on a vault that owned all eight seedable
   * apps. The resolver mirrors `codeDirOverride` in build-gateway: bundled and
   * installed wins, everything else is the code store.
   */
  bundledAppDirs: () => ReadonlyMap<string, string>;
}

/** The directory an app's `seed.js` would live in, bundled tree first. */
function appDirsFor(deps: DemoRouteDeps): Map<string, string> {
  const dirs = new Map<string, string>();
  const codeAppsDir = deps.codeAppsDir();
  try {
    for (const entry of readdirSync(codeAppsDir))
      dirs.set(entry, path.join(codeAppsDir, entry));
  } catch {
    /* a vault with no code store yet is the normal case now */
  }
  // Bundled last so an installed blueprint wins over a same-named store entry,
  // which is the same precedence the listing union and the compat route use.
  for (const [appId, dir] of deps.bundledAppDirs()) dirs.set(appId, dir);
  return dirs;
}

/** Apps that ship a seed.js scenario generator, wherever they serve from. */
function seedableApps(deps: DemoRouteDeps): Map<string, string> {
  const seedable = new Map<string, string>();
  for (const [appId, dir] of appDirsFor(deps)) {
    const seedFile = path.join(dir, "seed.js");
    if (existsSync(seedFile)) seedable.set(appId, seedFile);
  }
  return seedable;
}

export function makeDemoRouteHandler(
  vaults: VaultRegistry,
  deps: DemoRouteDeps
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`))
      return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//u, "");
    const appId = rest === "" ? null : decodeURIComponent(rest);
    const method = req.method ?? "GET";
    const plane = vaults.current();

    if (method === "GET" && appId === null) {
      const rowsByApp = new Map(
        plane.demoStatus().map((s) => [s.appId, s.rows])
      );
      const seedable = seedableApps(deps);
      const apps = [...new Set([...rowsByApp.keys(), ...seedable.keys()])]
        .sort()
        .map((id) => ({
          appId: id,
          rows: rowsByApp.get(id) ?? 0,
          seedable: seedable.has(id),
        }));
      sendJson(res, 200, { apps });
      return true;
    }

    if (method === "POST" && appId !== null) {
      const seedFile = seedableApps(deps).get(appId);
      if (seedFile === undefined) {
        sendJson(res, 404, {
          error: `app "${appId}" ships no seed.js scenario`,
        });
        return true;
      }
      const outcome = await runHandler({
        app: {
          id: appId,
          dir: path.join(vaults.currentWorkspace().appsDir, appId),
        },
        handlerFile: seedFile,
        handlerKind: "action",
        // Deterministic-by-default: generators derive their randomness from
        // `input.seed` and their dates from `input.now`, so the same load
        // reproduces the same scenario (test fixtures ride this too).
        args: { input: { seed: 1, now: new Date().toISOString() } },
        timeoutMs: 60_000,
        vault: vaults.demoBridgeFor(appId),
        timeModuleUrl: TIME_ENGINE_MODULE_URL,
      });
      if (!outcome.ok) {
        sendJson(res, 500, {
          error: outcome.error ?? "seed generator failed",
          logs: outcome.logs,
        });
        return true;
      }
      const status = plane.demoStatus().find((s) => s.appId === appId);
      sendJson(res, 200, {
        ok: true,
        result: outcome.value ?? null,
        rows: status?.rows ?? 0,
      });
      return true;
    }

    if (method === "DELETE") {
      const result = plane.purgeDemo(appId ?? undefined);
      sendJson(res, 200, result);
      return true;
    }

    sendJson(res, 405, { error: `unsupported ${method} on ${url.pathname}` });
    return true;
  };
}
