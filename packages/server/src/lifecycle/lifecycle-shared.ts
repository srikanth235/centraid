import type { IncomingMessage, ServerResponse } from "node:http";

import { AppScaffoldError } from "@centraid/blueprints";
import { ManifestError } from "@centraid/server/automation";
import type * as automation from "@centraid/server/automation";
import { ExtSpecError } from "@centraid/vault";

import { validateManifestAt } from "../routes/apps-store-routes.js";
import { sendJson, writeFileMap } from "../routes/route-helpers.js";
import type { FileMapEntry } from "../routes/route-helpers.js";
import type { WorktreeStore } from "../worktree-store/index.js";
import { WorktreeStoreError } from "../worktree-store/index.js";
import { applyExtOnPublish } from "./ext-band.js";
import type { ExtBandOps } from "./ext-band.js";

export interface LifecycleRouteOptions {
  store: WorktreeStore;
  codeAppsDir: () => string;
  templatesCacheDir?: string;
  /** Registers WITHOUT publishing. */
  ensureRegistered: (appId: string) => Promise<void>;
  /** Also deletes the app state dir. */
  deregister: (appId: string) => Promise<void>;
  reconcile: () => void;
  ext?: ExtBandOps;
  compileAutomation?: (input: {
    automationRef: string;
    runId: string;
    enableOnSuccess: boolean;
  }) => void;
  reviseAutomation?: (input: {
    row: automation.Row;
    steering: string;
    revisionTurnId: string;
    compileTurnId: string;
  }) => void;
  /** Bundled ids are RESERVED: no code-store app may shadow one (#434). */
  isBundledAppId?: (id: string) => boolean;
  /** Toggle + declared settings only; never delete, compile, or rewrite. */
  isSystemManagedAutomation?: (automationRef: string) => boolean;
  isSystemManagedApp?: (appId: string) => boolean;
  installBundledApp?: (
    templateId: string
  ) => Promise<InstalledBundledApp | undefined>;
  /** False falls through to the code-store app.json rewrite. */
  renameBundledApp?: (appId: string, name: string | null) => boolean;
}

export interface InstalledBundledApp {
  id: string;
  name?: string;
  description?: string;
  iconKey?: string;
  colorKey?: string;
  alreadyInstalled: boolean;
}

export function webhookUrl(req: IncomingMessage, webhookId: string): string {
  const host = req.headers.host ?? "127.0.0.1";
  const forwarded = req.headers["x-forwarded-proto"];
  const proto =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(",")[0]
      ?.trim() || "http";
  return `${proto}://${host}/_centraid-hook/${webhookId}`;
}

export async function ensureSession(
  store: WorktreeStore,
  sessionId: string
): Promise<string> {
  try {
    const handle = await store.openSession(sessionId);
    return handle.id;
  } catch (error) {
    if (error instanceof WorktreeStoreError && error.code === "session_exists")
      return sessionId;
    throw error;
  }
}

/** Ephemeral sessions start fresh off `main`: a leftover worktree may sit on a
 *  stale `main` and stage onto pre-delete state. */
export async function prepareLifecycleSession(
  store: WorktreeStore,
  sessionId: string,
  ephemeral: boolean
): Promise<void> {
  if (!ephemeral) {
    await ensureSession(store, sessionId);
    return;
  }
  await store.closeSession(sessionId);
  await store.openSession(sessionId);
}

export function defaultSessionId(appId: string): string {
  return `lifecycle-${appId}`;
}

/** `"all"` is deliberately NOT accepted (#659); unrecognized reads as unset →
 *  the bounded default, never keep-everything. */
export function parseHistoryKeep(
  raw: unknown
): automation.HistoryKeep | undefined {
  if (raw === "errors") return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.count === "number") return { count: obj.count };
    if (typeof obj.days === "number") return { days: obj.days };
  }
  return undefined;
}

/** Every publishing mutation funnels through here (#147). */
export async function publishAndReconcile(
  opts: LifecycleRouteOptions,
  input: {
    appId: string;
    sessionId: string;
    appDir: string;
    message: string;
    ephemeralSession?: boolean;
  }
): Promise<void> {
  const validationError = await validateManifestAt(input.appDir, {
    releaseManagedModelBundle: opts.isSystemManagedApp?.(input.appId) === true,
  });
  if (validationError)
    throw new AppScaffoldError("invalid_manifest", validationError);
  // Post-rebase, pre-ff-merge, inside the store mutex: a refused ext spec aborts
  // the publish with the vault untouched (#286).
  const ext = opts.ext;
  const appId = input.appId;
  await opts.store.publish({
    sessionId: input.sessionId,
    appId,
    message: input.message,
    ...(ext
      ? {
          beforeMerge: async (worktreeAppDir: string) => {
            await applyExtOnPublish(ext, appId, worktreeAppDir);
          },
        }
      : {}),
  });
  await opts.ensureRegistered(input.appId);
  opts.reconcile();
  if (input.ephemeralSession) await opts.store.closeSession(input.sessionId);
}

/** The vault ext band is RETAINED; purging it is a separate owner act. */
export async function deleteAppAndReconcile(
  opts: LifecycleRouteOptions,
  appId: string
): Promise<void> {
  await opts.store.deleteApp(appId);
  await opts.deregister(appId);
  opts.reconcile();
}

export async function stageAndMaybePublish(
  opts: LifecycleRouteOptions,
  input: {
    appId: string;
    sessionId: string;
    files: ReadonlyArray<FileMapEntry>;
    publish: boolean;
    message: string;
    /** Closes the one-shot session, or its worktree is orphaned. */
    ephemeralSession?: boolean;
  }
): Promise<void> {
  const appDir = await opts.store.snapshotSessionAppDir(
    input.sessionId,
    input.appId
  );
  await writeFileMap(appDir, input.files);
  if (!input.publish) {
    await opts.ensureRegistered(input.appId);
    return;
  }
  await publishAndReconcile(opts, {
    appId: input.appId,
    sessionId: input.sessionId,
    appDir,
    message: input.message,
    ...(input.ephemeralSession
      ? { ephemeralSession: input.ephemeralSession }
      : {}),
  });
}

export function sendLifecycleError(res: ServerResponse, err: unknown): true {
  if (err instanceof AppScaffoldError) {
    const status =
      err.code === "already_exists"
        ? 409
        : err.code === "not_found"
          ? 404
          : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  if (err instanceof ManifestError) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `Invalid automation manifest (${err.code}): ${err.message}`,
    });
  }
  if (err instanceof ExtSpecError) {
    return sendJson(res, 400, {
      error: "invalid_ext_spec",
      message: err.message,
    });
  }
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
