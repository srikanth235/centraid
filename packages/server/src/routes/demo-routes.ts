// Scenario-seed routes (#290). Writes ride the demo register (`seed.demo`),
// invisible to automations, purgeable in one act.

import { existsSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { runHandler } from "@centraid/server/engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { sendJson } from "./route-helpers.js";

const PREFIX = "/centraid/_vault/demo";
const TIME_ENGINE_MODULE_URL = import.meta.resolve("@centraid/core/time");
// Photos' deterministic roll is intentionally larger than the other demos.
// Keep the route bounded, but do not turn a valid seed into a false 500 while
// the worker is still committing its media rows.
const DEMO_SEED_TIMEOUT_MS = 180_000;

export interface DemoRouteDeps {
  codeAppsDir: () => string;
  /** Bundled blueprint dirs by id. Without this, GET /demo is `{apps:[]}` (#434). */
  bundledAppDirs: () => ReadonlyMap<string, string>;
}

function appDirsFor(deps: DemoRouteDeps): Map<string, string> {
  const dirs = new Map<string, string>();
  const codeAppsDir = deps.codeAppsDir();
  try {
    for (const entry of readdirSync(codeAppsDir))
      dirs.set(entry, path.join(codeAppsDir, entry));
  } catch {
    /* a vault with no code store yet is the normal case */
  }
  // Bundled last so an installed blueprint wins over a same-named store entry.
  for (const [appId, dir] of deps.bundledAppDirs()) dirs.set(appId, dir);
  return dirs;
}

function seedableApps(deps: DemoRouteDeps): Map<string, string> {
  const seedable = new Map<string, string>();
  for (const [appId, dir] of appDirsFor(deps)) {
    const seedFile = path.join(dir, "seed.js");
    if (existsSync(seedFile)) seedable.set(appId, seedFile);
  }
  return seedable;
}

async function runSeed(input: {
  appId: string;
  seedFile: string;
  vaults: VaultRegistry;
  now: string;
}): Promise<Awaited<ReturnType<typeof runHandler>>> {
  return runHandler({
    app: {
      id: input.appId,
      dir: path.join(input.vaults.currentWorkspace().appsDir, input.appId),
    },
    handlerFile: input.seedFile,
    handlerKind: "action",
    // One fixture operation shares a clock value across every app. Generators
    // derive randomness from `input.seed` and dates from `input.now`.
    args: { input: { seed: 1, now: input.now } },
    timeoutMs: DEMO_SEED_TIMEOUT_MS,
    vault: input.vaults.demoBridgeFor(input.appId),
    timeModuleUrl: TIME_ENGINE_MODULE_URL,
  });
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
      const outcome = await runSeed({
        appId,
        seedFile,
        vaults,
        now: new Date().toISOString(),
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

    if (method === "POST" && appId === null) {
      const seedable = seedableApps(deps);
      const status = plane.demoStatus();
      const rowsByApp = new Map(
        status.map((entry) => [entry.appId, entry.rows])
      );
      const seeded: string[] = [];
      const skipped: string[] = [];
      const now = new Date().toISOString();

      for (const [id, seedFile] of seedable) {
        if ((rowsByApp.get(id) ?? 0) > 0) {
          skipped.push(id);
          continue;
        }
        // Deliberately ordered: generators share the same vault and some
        // scenarios create rows other scenarios reference.
        // oxlint-disable-next-line no-await-in-loop -- vault seed order is part of the fixture contract
        const outcome = await runSeed({
          appId: id,
          seedFile,
          vaults,
          now,
        });
        if (!outcome.ok) {
          sendJson(res, 500, {
            error: outcome.error ?? "seed generator failed",
            appId: id,
            seeded,
            skipped,
            logs: outcome.logs,
          });
          return true;
        }
        seeded.push(id);
      }

      sendJson(res, 200, {
        ok: true,
        now,
        seeded,
        skipped,
        apps: plane.demoStatus(),
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
