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
  codeAppsDir: () => string;
  bundledAppDirs: () => ReadonlyMap<string, string>;
}

function appDirsFor(deps: DemoRouteDeps): Map<string, string> {
  const dirs = new Map<string, string>();
  const codeAppsDir = deps.codeAppsDir();
  try {
    for (const entry of readdirSync(codeAppsDir))
      dirs.set(entry, path.join(codeAppsDir, entry));
  } catch {
    // Intentionally empty.
  }
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
