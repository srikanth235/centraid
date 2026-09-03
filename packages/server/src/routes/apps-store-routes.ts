import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { ExtSpecError } from "@centraid/vault";

import { applyExtOnPublish, readExtSpecs } from "../lifecycle/ext-band.js";
import type { ExtBandOps } from "../lifecycle/ext-band.js";
import { validateManifestAt } from "../validate-manifest.js";
import type { WorktreeStore } from "../worktree-store/index.js";
import { WorktreeStoreError } from "../worktree-store/index.js";
import { readDraftFiles, writeDraftFile } from "./apps-store-draft-files.js";
import {
  readBody,
  readJson,
  sendJson,
  sendJsonConditional,
} from "./route-helpers.js";

export { validateManifestAt } from "../validate-manifest.js";

export interface AppsStoreRouteOptions {
  isReadOnlyApp?: (appId: string) => boolean;
  onAppLive?: (appId: string) => Promise<void>;
  onAppDeleted?: (appId: string) => Promise<void>;
  bundledApps?: () => Promise<AppMetaRow[]>;
  ext?: ExtBandOps;
}

export interface AppMetaRow {
  id: string;
  name?: string;
  description?: string;
  kind?: "app" | "automation";
  iconKey?: string;
  colorKey?: string;
}

export function makeAppsStoreRouteHandler(
  store: WorktreeStore,
  opts: AppsStoreRouteOptions = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    if (!pathname.startsWith("/centraid/_apps")) return false;
    const segments = pathname
      .slice("/centraid/".length)
      .split("/")
      .filter(Boolean);
    const method = (req.method ?? "GET").toUpperCase();

    try {
      if (segments.length === 1 && method === "GET") {
        const storeApps = await store.listAppsWithMeta();
        const bundled = opts.bundledApps ? await opts.bundledApps() : [];
        const bundledIds = new Set(bundled.map((a) => a.id));
        const apps = [
          ...bundled,
          ...storeApps.filter((a) => !bundledIds.has(a.id)),
        ];
        return sendJsonConditional(req, res, 200, apps);
      }

      if (segments[1] === "_sessions") {
        return await handleSessions(
          store,
          req,
          res,
          method,
          segments,
          opts.ext
        );
      }

      const appId = decodeURIComponent(segments[1] ?? "");
      const verb = segments[2];
      if (!appId || appId.startsWith("_")) return false;
      if (method !== "GET" && opts.isReadOnlyApp?.(appId)) {
        sendJson(res, 403, {
          error: "system_recipe_read_only",
          message: `${appId} is a release-managed recognition recipe and cannot be changed through the app store.`,
        });
        return true;
      }

      if (segments.length === 2 && method === "DELETE") {
        let codeRemoved = true;
        try {
          await store.deleteApp(appId);
        } catch (error) {
          if (
            error instanceof WorktreeStoreError &&
            error.code === "no_changes"
          ) {
            codeRemoved = false;
          } else {
            throw error;
          }
        }
        if (opts.onAppDeleted) await opts.onAppDeleted(appId);
        sendJson(res, 200, { id: appId, deleted: true, codeRemoved });
        return true;
      }

      if (verb === "publish" && method === "POST") {
        return await handlePublish(
          store,
          req,
          res,
          appId,
          opts.onAppLive,
          opts.ext
        );
      }
      if (verb === "rollback" && method === "POST") {
        return await handleRollback(store, req, res, appId, opts.onAppLive);
      }
      if (verb === "reset-data" && method === "POST") {
        return await handleResetData(store, req, res, appId, opts.ext);
      }
      if (verb === "git-versions" && method === "GET") {
        const versions = await store.listVersions(appId);
        sendJson(res, 200, { versions });
        return true;
      }
      if (verb === "files") {
        return await handleFiles(store, req, res, method, appId, segments, url);
      }

      return false;
    } catch (error) {
      return sendStoreError(res, error);
    }
  };
}

async function handleSessions(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  ext?: ExtBandOps
): Promise<boolean> {
  if (segments.length === 2) {
    if (method === "POST") {
      const body = await readJson(req);
      const sessionId =
        typeof body.sessionId === "string" && body.sessionId.length > 0
          ? body.sessionId
          : `s_${Date.now().toString(36)}`;
      const handle = await store.openSession(sessionId);
      sendJson(res, 201, { sessionId: handle.id, branch: handle.branch });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { sessions: await store.listSessions() });
      return true;
    }
    return false;
  }
  if (segments.length === 3 && method === "DELETE") {
    const sessionId = decodeURIComponent(segments[2] ?? "");
    if (ext) {
      for (const appId of await store.sessionAppIds(sessionId)) {
        try {
          ext.dropAppExtDraft(appId);
        } catch {
          // Intentionally empty.
        }
      }
    }
    await store.closeSession(sessionId);
    sendJson(res, 200, { sessionId });
    return true;
  }
  return false;
}

async function handlePublish(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  onAppLive?: (appId: string) => Promise<void>,
  ext?: ExtBandOps
): Promise<boolean> {
  const body = await readJson(req);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const message = typeof body.message === "string" ? body.message : "";
  if (!sessionId || !message) {
    sendJson(res, 400, {
      error: "bad_request",
      message: "publish needs { sessionId, message }",
    });
    return true;
  }

  const appDir = await store.snapshotSessionAppDir(sessionId, appId);
  const validationError = await validateManifestAt(appDir);
  if (validationError) {
    sendJson(res, 400, { error: "invalid_manifest", message: validationError });
    return true;
  }

  let result;
  let extOutcome:
    | { created: string[]; dropped: string[]; altered: string[] }
    | undefined;
  try {
    result = await store.publish({
      sessionId,
      appId,
      message,
      ...(ext
        ? {
            beforeMerge: async (dir: string) => {
              extOutcome = await applyExtOnPublish(ext, appId, dir);
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof ExtSpecError) {
      sendJson(res, 400, { error: "invalid_ext_spec", message: error.message });
      return true;
    }
    throw error;
  }
  await onAppLive?.(appId);
  sendJson(res, 201, {
    id: appId,
    versionTag: result.versionTag,
    sha: result.sha,
    activated: true,
    ...(extOutcome ? { ext: extOutcome } : {}),
  });
  return true;
}

async function handleRollback(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  onAppLive?: (appId: string) => Promise<void>
): Promise<boolean> {
  const body = await readJson(req);
  const versionTag = typeof body.versionTag === "string" ? body.versionTag : "";
  if (!versionTag) {
    sendJson(res, 400, {
      error: "bad_request",
      message: "rollback needs { versionTag }",
    });
    return true;
  }
  const result = await store.rollback({ appId, versionTag });
  await onAppLive?.(appId);
  sendJson(res, 200, { id: appId, sha: result.sha, rolledBackTo: versionTag });
  return true;
}

async function handleResetData(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  ext?: ExtBandOps
): Promise<boolean> {
  const body = await readJson(req);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) {
    sendJson(res, 400, {
      error: "bad_request",
      message: "reset-data needs { sessionId }",
    });
    return true;
  }
  if (!ext) {
    sendJson(res, 400, {
      error: "bad_request",
      message: "reset-data needs a vault plane",
    });
    return true;
  }
  const worktreeAppDir = await store.snapshotSessionAppDir(sessionId, appId);
  try {
    const specs = await readExtSpecs(worktreeAppDir);
    const out =
      specs.length === 0
        ? { ...ext.dropAppExtDraft(appId), created: [], altered: [] }
        : ext.seedAppExtDraft(appId, specs, { reset: true });
    sendJson(res, 200, { id: appId, ext: out });
  } catch (error) {
    if (error instanceof ExtSpecError) {
      sendJson(res, 400, { error: "invalid_ext_spec", message: error.message });
      return true;
    }
    throw error;
  }
  return true;
}

async function handleFiles(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  appId: string,
  segments: string[],
  url: URL
): Promise<boolean> {
  if (method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!sessionId) {
      sendJson(res, 400, {
        error: "bad_request",
        message: "files read needs ?sessionId",
      });
      return true;
    }
    const appDir = await store.snapshotSessionAppDir(sessionId, appId);
    sendJson(res, 200, { files: await readDraftFiles(appDir) });
    return true;
  }
  if (method === "PUT") {
    const rel = segments
      .slice(3)
      .map((s) => decodeURIComponent(s))
      .join("/");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!sessionId || !rel) {
      sendJson(res, 400, {
        error: "bad_request",
        message: "files write needs ?sessionId + path",
      });
      return true;
    }
    const result = await writeDraftFile(
      store,
      sessionId,
      appId,
      rel,
      await readBody(req)
    );
    sendJson(res, 200, result);
    return true;
  }
  if (method === "DELETE") {
    const rel = segments
      .slice(3)
      .map((s) => decodeURIComponent(s))
      .join("/");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!sessionId || !rel) {
      sendJson(res, 400, {
        error: "bad_request",
        message: "files delete needs ?sessionId + path",
      });
      return true;
    }
    const appDir = await store.snapshotSessionAppDir(sessionId, appId);
    const abs = path.resolve(appDir, rel);
    if (abs !== appDir && !abs.startsWith(appDir + path.sep)) {
      throw new WorktreeStoreError(
        "invalid_app_id",
        `Refusing to delete outside the app: ${rel}`
      );
    }
    await fs.rm(abs, { force: true });
    sendJson(res, 200, { path: rel, deleted: true });
    return true;
  }
  return false;
}

function sendStoreError(res: ServerResponse, err: unknown): true {
  if (err instanceof WorktreeStoreError) {
    const status =
      err.code === "session_missing" || err.code === "tag_missing"
        ? 404
        : err.code === "session_exists"
          ? 409
          : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  return sendJson(res, 500, {
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}
