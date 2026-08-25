// Gateway prefs (#280): device-level config only — the vault owner IS the
// user, so there is no gateway-side identity. A JSON file, not a database.
// The wire prefix stays `/_centraid-user` for desktop-client compatibility.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { isHarnessKind } from "../conversation/turn.js";
import type { HarnessKind } from "../conversation/turn.js";

export interface PrefsPersistence {
  read: () => Record<string, unknown>;
  write: (prefs: Record<string, unknown>) => void;
}

export class PrefsStore {
  private readonly file: string | undefined;
  private readonly persistence: PrefsPersistence | undefined;
  private cache: Record<string, unknown> | undefined;

  constructor(source: string | PrefsPersistence) {
    if (typeof source === "string") this.file = source;
    else this.persistence = source;
  }

  private load(): Record<string, unknown> {
    if (this.cache) return this.cache;
    if (this.persistence) {
      this.cache = this.persistence.read();
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file!, "utf8")) as unknown;
      this.cache =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      // Missing or unreadable — a fresh host starts empty.
      this.cache = {};
    }
    return this.cache;
  }

  private persist(): void {
    if (this.persistence) {
      this.persistence.write(this.cache ?? {});
      return;
    }
    mkdirSync(path.dirname(this.file!), { recursive: true });
    const tmp = `${this.file!}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cache ?? {}, null, 2), {
      mode: 0o600,
    });
    renameSync(tmp, this.file!);
  }

  getAllPrefs(): Record<string, unknown> {
    return { ...this.load() };
  }

  /** `undefined` and `null` are deletions. Atomic (tmp + rename). */
  setPrefs(patch: Record<string, unknown>): Record<string, unknown> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return this.getAllPrefs();
    const prefs = this.load();
    for (const k of keys) {
      const v = patch[k];
      if (v === undefined || v === null) delete prefs[k];
      else prefs[k] = v;
    }
    this.persist();
    return this.getAllPrefs();
  }
}

/** `assistant` is the shell's vault assistant, `automations` `ctx.delegate`. */
export type ModelSubsystem = "assistant" | "ask" | "builder" | "automations";

/** `harness.<subsystem>`, then `harness.kind`, then `codex`. An empty string
 *  is unset, so a cleared pin falls back rather than pinning `''`. */
export function resolveSubsystemHarness(
  prefs: Record<string, unknown>,
  subsystem: ModelSubsystem
): string {
  const scoped = prefs[`harness.${subsystem}`];
  if (typeof scoped === "string" && scoped.length > 0) return scoped;
  const fallback = prefs["harness.kind"];
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return "codex";
}

/** The primary is always first; duplicate and unknown kinds are dropped. */
export function resolveSubsystemHarnessLadder(
  prefs: Record<string, unknown>,
  subsystem: ModelSubsystem,
  primary: HarnessKind
): HarnessKind[] {
  const raw =
    prefs[`harness.ladder.${subsystem}`] ?? prefs["harness.ladder.default"];
  let values: unknown = raw;
  if (typeof raw === "string") {
    try {
      values = JSON.parse(raw) as unknown;
    } catch {
      values = [];
    }
  }
  const candidates = Array.isArray(values) ? values : [];
  const ladder: HarnessKind[] = [primary];
  for (const value of candidates) {
    if (isHarnessKind(value) && !ladder.includes(value)) ladder.push(value);
  }
  return ladder;
}

/** `explicit`, then `model.<harnessKind>.<subsystem>`, then `.default`, then
 *  `undefined` — send no `model` at all so the harness uses its own. */
export function resolveSubsystemModel(
  prefs: Record<string, unknown>,
  harnessKind: string,
  subsystem: ModelSubsystem,
  explicit?: string
): string | undefined {
  if (explicit) return explicit;
  const scoped = prefs[`model.${harnessKind}.${subsystem}`];
  if (typeof scoped === "string" && scoped.length > 0) return scoped;
  const fallback = prefs[`model.${harnessKind}.default`];
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return undefined;
}

/** Keys are `config.<harnessKind>.<slot>.<category>`. The result stays
 *  category-keyed so adapter-specific ids never leak into policy. */
export function resolveSubsystemConfigPins(
  prefs: Record<string, unknown>,
  harnessKind: string,
  subsystem: ModelSubsystem,
  explicit: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const categories = new Set(Object.keys(explicit));
  const scopedPrefix = `config.${harnessKind}.${subsystem}.`;
  const defaultPrefix = `config.${harnessKind}.default.`;
  for (const key of Object.keys(prefs)) {
    if (key.startsWith(scopedPrefix))
      categories.add(key.slice(scopedPrefix.length));
    if (key.startsWith(defaultPrefix))
      categories.add(key.slice(defaultPrefix.length));
  }
  const resolved: Record<string, string> = {};
  for (const category of categories) {
    if (!category) continue;
    const requested = explicit[category];
    if (requested) {
      resolved[category] = requested;
      continue;
    }
    const scoped = prefs[`${scopedPrefix}${category}`];
    if (typeof scoped === "string" && scoped) {
      resolved[category] = scoped;
      continue;
    }
    const fallback = prefs[`${defaultPrefix}${category}`];
    if (typeof fallback === "string" && fallback) resolved[category] = fallback;
  }
  return resolved;
}

const ROUTE_PREFIX = "/_centraid-user";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

export interface UserStoreRouteHooks {
  /** Return a user-facing reason to reject the patch. */
  validatePatch?: (
    patch: Record<string, unknown>,
    current: Record<string, unknown>
  ) => Promise<string | undefined>;
  afterPatch?: (
    patch: Record<string, unknown>,
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ) => Promise<void> | void;
}

/** `getOwnerId` backs `/id` with the ACTIVE vault's owner party id; without a
 *  provider that route 404s. */
export function makeUserStoreRouteHandler(
  getStore: () => PrefsStore,
  getOwnerId?: () => string,
  hooks: UserStoreRouteHooks = {}
) {
  let writeTail: Promise<void> = Promise.resolve();
  const withWriteLock = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = writeTail;
    let release!: () => void;
    writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  };
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(ROUTE_PREFIX)) return false;
    const url = new URL(req.url, "http://x");
    const sub = url.pathname.slice(ROUTE_PREFIX.length);
    const method = (req.method ?? "GET").toUpperCase();
    const store = getStore();

    try {
      if (sub === "/id" || sub === "/id/") {
        if (method !== "GET") {
          sendError(res, 405, "method not allowed");
          return true;
        }
        if (!getOwnerId) {
          sendError(res, 404, "no vault mounted — there is no owner identity");
          return true;
        }
        sendJson(res, 200, { id: getOwnerId() });
        return true;
      }
      if (sub === "/prefs" || sub === "/prefs/") {
        if (method === "GET") {
          sendJson(res, 200, { prefs: store.getAllPrefs() });
          return true;
        }
        if (method === "PUT") {
          const body = (await readJsonBody(req)) as
            | { patch?: Record<string, unknown> }
            | undefined;
          const patch = body?.patch;
          if (!patch || typeof patch !== "object") {
            sendError(res, 400, "patch object is required");
            return true;
          }
          await withWriteLock(async () => {
            const before = store.getAllPrefs();
            const rejection = await hooks.validatePatch?.(patch, before);
            if (rejection) {
              sendError(res, 409, rejection);
              return;
            }
            const after = store.setPrefs(patch);
            await hooks.afterPatch?.(patch, before, after);
            sendJson(res, 200, { prefs: after });
          });
          return true;
        }
        sendError(res, 405, "method not allowed");
        return true;
      }
      sendError(res, 404, "unknown user-store route");
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sendError(res, 500, msg);
      return true;
    }
  };
}
