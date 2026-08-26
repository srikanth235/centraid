// governance: allow-repo-hygiene file-size-limit ctx.vault bridge threading (duaility §12); validation/envelope split tracked separately
/**
 * Declared-handler dispatcher (#107, #286): validate `input` against `app.json`
 * with Ajv, hand off to `handler-runner`. That is ALL it routes — no `_sql`
 * built-ins; handlers reach data via `ctx.vault`. Errors stay MCP-shaped so the
 * HTTP shim can map `structuredContent.code` to a status.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";

import { appDataDir } from "../registry/app-paths.js";
import {
  APP_MANIFEST_FILE,
  ManifestError,
  compileSchema,
  findAction,
  findQuery,
  parseManifest,
} from "../registry/manifest.js";
import type {
  Manifest,
  ManifestActionEntry,
  ManifestQueryEntry,
} from "../registry/manifest.js";
import type { Registry } from "../registry/registry.js";
import type { RegistryEntry } from "../types.js";
import { runHandler } from "./handler-runner.js";
import type { VaultBridge } from "./vault-bridge.js";

export type ToolErrorCode =
  | "UNKNOWN_APP"
  | "UNKNOWN_ACTION"
  | "UNKNOWN_QUERY"
  | "WRONG_KIND"
  | "INVALID_INPUT"
  | "INVALID_MANIFEST"
  | "NO_ACTIVE_VERSION"
  | "HANDLER_ERROR"
  /** Admission gate refused a slot (#351): nothing ran, so retry is safe. */
  | "GATEWAY_BUSY";

export interface ToolErrorContent {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly path?: string;
}

export interface ToolErrorResult {
  readonly isError: true;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: ToolErrorContent;
}

export interface ToolSuccessResult {
  readonly isError: false;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: unknown;
}

export type ToolResult = ToolErrorResult | ToolSuccessResult;

function errorResult(
  code: ToolErrorCode,
  message: string,
  pathLocal?: string
): ToolErrorResult {
  const structured: ToolErrorContent =
    pathLocal === undefined
      ? { code, message }
      : { code, message, path: pathLocal };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function successResult(value: unknown): ToolSuccessResult {
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(value ?? null) }],
    structuredContent: value,
  };
}

export interface CentraidWriteInput {
  readonly app: string;
  readonly action: string;
  readonly input?: unknown;
  /** Binds every vault invocation to replay-safe ids. */
  readonly intentId?: string;
}

export interface CentraidReadInput {
  readonly app: string;
  readonly query: string;
  readonly input?: unknown;
}

export interface CentraidDescribeInput {
  readonly app?: string;
  readonly action?: string;
  readonly query?: string;
}

export interface DispatcherOptions {
  /** A resolver keeps dispatch on the ACTIVE vault's registry (#280). */
  readonly registry: Registry | (() => Registry);
  /** Feeds the `_changes` SSE stream. */
  readonly onWriteFor?: (appId: string) => (tables: string[]) => void;
  /** The git store owns all code (#137); unresolved means not live. */
  readonly codeDirOverride?: (appId: string) => Promise<string | undefined>;
  /** Absent must fail `ctx.vault.*` closed with VAULT_UNAVAILABLE. */
  readonly vaultFor?: (appId: string) => VaultBridge;
  /** Mounted as handler `ctx.time`. */
  readonly timeModuleUrl?: string;
}

/** Keyed by code dir + mtime so a version swap or dev-watch rewrite drops it. */
interface ManifestCacheEntry {
  readonly codeDir: string;
  readonly mtimeMs: number;
  readonly manifest: Manifest;
  readonly actionValidators: Map<string, ValidateFunction>;
  readonly queryValidators: Map<string, ValidateFunction>;
}

export class Dispatcher {
  private readonly registryProvider: () => Registry;
  private readonly onWriteFor?: (appId: string) => (tables: string[]) => void;
  private readonly codeDirOverride?: (
    appId: string
  ) => Promise<string | undefined>;
  private readonly vaultFor?: (appId: string) => VaultBridge;
  private readonly timeModuleUrl?: string;
  private readonly manifestCache = new Map<string, ManifestCacheEntry>();

  constructor(opts: DispatcherOptions) {
    const reg = opts.registry;
    this.registryProvider = typeof reg === "function" ? reg : () => reg;
    if (opts.onWriteFor) this.onWriteFor = opts.onWriteFor;
    if (opts.codeDirOverride) this.codeDirOverride = opts.codeDirOverride;
    if (opts.vaultFor) this.vaultFor = opts.vaultFor;
    if (opts.timeModuleUrl) this.timeModuleUrl = opts.timeModuleUrl;
  }

  private get registry(): Registry {
    return this.registryProvider();
  }

  private async resolveCodeDir(
    entry: RegistryEntry
  ): Promise<string | undefined> {
    return this.codeDirOverride ? this.codeDirOverride(entry.id) : undefined;
  }

  private async loadManifest(codeDir: string): Promise<Manifest> {
    const file = path.join(codeDir, APP_MANIFEST_FILE);
    const stat = await fs.stat(file);
    const cached = this.manifestCache.get(codeDir);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.manifest;
    const text = await fs.readFile(file, "utf8");
    const manifest = parseManifest(text);
    this.manifestCache.set(codeDir, {
      codeDir,
      mtimeMs: stat.mtimeMs,
      manifest,
      actionValidators: new Map(),
      queryValidators: new Map(),
    });
    return manifest;
  }

  private validatorFor(
    codeDir: string,
    kind: "action" | "query",
    name: string,
    schema: Record<string, unknown>
  ): ValidateFunction {
    const entry = this.manifestCache.get(codeDir);
    if (!entry) return compileSchema(schema);
    const cache =
      kind === "action" ? entry.actionValidators : entry.queryValidators;
    let v = cache.get(name);
    if (!v) {
      v = compileSchema(schema);
      cache.set(name, v);
    }
    return v;
  }

  /** Call when a version is activated. */
  invalidate(codeDir?: string): void {
    if (codeDir === undefined) this.manifestCache.clear();
    else this.manifestCache.delete(codeDir);
  }

  // `overrideCodeDir` is the draft-preview path (#141), on all three verbs.
  async describe(
    input: CentraidDescribeInput,
    overrideCodeDir?: string
  ): Promise<ToolResult> {
    const { app, action, query } = input;
    if (app === undefined) {
      const out = await Promise.all(
        this.registry.list().map(async (entry) => {
          try {
            const codeDir = await this.resolveCodeDir(entry);
            if (!codeDir) {
              return { id: entry.id, error: "no_active_version" };
            }
            const manifest = await this.loadManifest(codeDir);
            return { id: entry.id, manifest };
          } catch (error) {
            return {
              id: entry.id,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      );
      return successResult({ apps: out });
    }

    const entry = this.registry.get(app);
    if (!entry) {
      return errorResult("UNKNOWN_APP", `app "${app}" is not registered`);
    }
    const codeDir = overrideCodeDir ?? (await this.resolveCodeDir(entry));
    if (!codeDir) {
      return errorResult(
        "NO_ACTIVE_VERSION",
        `app "${app}" has no active version`
      );
    }
    let manifest: Manifest;
    try {
      manifest = await this.loadManifest(codeDir);
    } catch (error) {
      return manifestErrorToResult(app, error);
    }

    if (action === undefined && query === undefined) {
      // The manifest IS the app's shape; there is no per-app SQLite schema.
      return successResult({ manifest });
    }
    if (action !== undefined) {
      const a = findAction(manifest, action);
      if (!a) {
        return errorResult(
          "UNKNOWN_ACTION",
          `app "${app}" has no action "${action}"`
        );
      }
      return successResult({
        app: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
        },
        action: a,
      });
    }
    if (query !== undefined) {
      const q = findQuery(manifest, query);
      if (!q) {
        return errorResult(
          "UNKNOWN_QUERY",
          `app "${app}" has no query "${query}"`
        );
      }
      return successResult({
        app: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
        },
        query: q,
      });
    }
    // unreachable
    return successResult(manifest);
  }

  async write(
    input: CentraidWriteInput,
    overrideCodeDir?: string
  ): Promise<ToolResult> {
    const {
      app: appId,
      action: actionName,
      input: handlerInput,
      intentId,
    } = input;
    if (!appId || !actionName) {
      return errorResult(
        "INVALID_INPUT",
        "an action invocation requires { app, action }"
      );
    }
    const entry = this.registry.get(appId);
    if (!entry) {
      return errorResult("UNKNOWN_APP", `app "${appId}" is not registered`);
    }
    // Draft mode: logs land beside the draft code.
    const dataDir = overrideCodeDir ?? appDataDir(entry);
    const codeDir = overrideCodeDir ?? (await this.resolveCodeDir(entry));
    if (!codeDir) {
      return errorResult(
        "NO_ACTIVE_VERSION",
        `app "${appId}" has no active version`
      );
    }
    let manifest: Manifest;
    try {
      manifest = await this.loadManifest(codeDir);
    } catch (error) {
      return manifestErrorToResult(appId, error);
    }
    // WRONG_KIND, not UNKNOWN_ACTION: the handler exists, the route is wrong.
    if (findQuery(manifest, actionName) && !findAction(manifest, actionName)) {
      return errorResult(
        "WRONG_KIND",
        `"${actionName}" is a query on app "${appId}" — use the queries route`
      );
    }
    const entryDef = findAction(manifest, actionName);
    if (!entryDef) {
      return errorResult(
        "UNKNOWN_ACTION",
        `app "${appId}" has no action "${actionName}"`
      );
    }
    const validation = this.validateInput(
      codeDir,
      "action",
      entryDef,
      handlerInput
    );
    if (validation) return validation;

    const outcome = await runHandler({
      app: { id: entry.id, dir: dataDir },
      handlerFile: await resolveHandlerFile(codeDir, "actions", actionName),
      handlerKind: "action",
      args: { params: {}, body: handlerInput },
      timeoutMs: 30_000,
      ...(this.onWriteFor ? { onWrite: this.onWriteFor(appId) } : {}),
      ...(this.vaultFor
        ? {
            vault: intentId
              ? bindIntentToVaultBridge(this.vaultFor(appId), intentId)
              : this.vaultFor(appId),
          }
        : {}),
      ...(this.timeModuleUrl ? { timeModuleUrl: this.timeModuleUrl } : {}),
    });
    if (!outcome.ok) {
      if (outcome.busy) {
        return errorResult("GATEWAY_BUSY", outcome.error ?? "gateway busy");
      }
      return errorResult(
        "HANDLER_ERROR",
        outcome.error ?? "action handler failed"
      );
    }
    // Unwrap `{ status, body }`; a >=400 status must become HANDLER_ERROR
    // rather than pass the error JSON through as success.
    const result = (outcome.value ?? null) as {
      status?: number;
      body?: unknown;
    } | null;
    if (
      result &&
      typeof result === "object" &&
      typeof result.status === "number" &&
      result.status >= 400
    ) {
      const bodyText =
        result.body && typeof result.body === "object" && "error" in result.body
          ? String((result.body as { error?: unknown }).error)
          : `action returned status ${result.status}`;
      return errorResult("HANDLER_ERROR", bodyText);
    }
    return successResult(result?.body ?? null);
  }

  async read(
    input: CentraidReadInput,
    overrideCodeDir?: string
  ): Promise<ToolResult> {
    const { app: appId, query: queryName, input: handlerInput } = input;
    if (!appId || !queryName) {
      return errorResult(
        "INVALID_INPUT",
        "a query invocation requires { app, query }"
      );
    }
    const entry = this.registry.get(appId);
    if (!entry) {
      return errorResult("UNKNOWN_APP", `app "${appId}" is not registered`);
    }
    const dataDir = overrideCodeDir ?? appDataDir(entry); // draft: see write
    const codeDir = overrideCodeDir ?? (await this.resolveCodeDir(entry));
    if (!codeDir) {
      return errorResult(
        "NO_ACTIVE_VERSION",
        `app "${appId}" has no active version`
      );
    }
    let manifest: Manifest;
    try {
      manifest = await this.loadManifest(codeDir);
    } catch (error) {
      return manifestErrorToResult(appId, error);
    }
    if (findAction(manifest, queryName) && !findQuery(manifest, queryName)) {
      return errorResult(
        "WRONG_KIND",
        `"${queryName}" is an action on app "${appId}" — use the actions route`
      );
    }
    const entryDef = findQuery(manifest, queryName);
    if (!entryDef) {
      return errorResult(
        "UNKNOWN_QUERY",
        `app "${appId}" has no query "${queryName}"`
      );
    }
    const validation = this.validateInput(
      codeDir,
      "query",
      entryDef,
      handlerInput
    );
    if (validation) return validation;

    const outcome = await runHandler({
      app: { id: entry.id, dir: dataDir },
      handlerFile: await resolveHandlerFile(codeDir, "queries", queryName),
      handlerKind: "query",
      args: {
        params: {},
        // Both names: dropping either breaks one generation of handlers.
        query: (handlerInput ?? {}) as Record<string, unknown>,
        input: handlerInput,
      },
      timeoutMs: 10_000,
      ...(this.vaultFor ? { vault: this.vaultFor(appId) } : {}),
      ...(this.timeModuleUrl ? { timeModuleUrl: this.timeModuleUrl } : {}),
    });
    if (!outcome.ok) {
      if (outcome.busy) {
        return errorResult("GATEWAY_BUSY", outcome.error ?? "gateway busy");
      }
      return errorResult(
        "HANDLER_ERROR",
        outcome.error ?? "query handler failed"
      );
    }
    return successResult(outcome.value ?? null);
  }

  private validateInput(
    codeDir: string,
    kind: "action" | "query",
    entry: ManifestActionEntry | ManifestQueryEntry,
    input: unknown
  ): ToolErrorResult | undefined {
    let validate: ValidateFunction;
    try {
      validate = this.validatorFor(codeDir, kind, entry.name, entry.input);
    } catch (error) {
      return errorResult(
        "INVALID_MANIFEST",
        `manifest ${kind} "${entry.name}" has an invalid input schema: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // Ajv needs an explicit value; omitting `input` on a no-arg handler is legal.
    const data = input === undefined ? {} : input;
    if (validate(data)) return undefined;
    const errs = validate.errors ?? [];
    const first = errs[0];
    const pathLocal = first?.instancePath || "";
    const msg = first?.message ?? "input validation failed";
    return errorResult(
      "INVALID_INPUT",
      `${kind} "${entry.name}" rejected input: ${msg}`,
      pathLocal || undefined
    );
  }
}

/**
 * Ids derive from intent + call ordinal so they stay stable across offline
 * retries: a crash after canonical commit must not re-execute the command.
 */
function bindIntentToVaultBridge(
  bridge: VaultBridge,
  intentId: string
): VaultBridge {
  let invocationIndex = 0;
  return (call) => {
    if (call.op !== "invoke") return bridge(call);
    // JSON framing keeps [intent, ordinal] injective; the prefix keeps the lane disjoint.
    const generatedInvocationId = `replica:v1:${createHash("sha256")
      .update(
        JSON.stringify([
          "centraid.replica-invocation.v1",
          intentId,
          invocationIndex,
        ])
      )
      .digest("hex")}`;
    invocationIndex += 1;
    return bridge({
      ...call,
      payload: {
        ...call.payload,
        intentId,
        // Never a handler-selected id: a random one re-executes on every retry.
        invocationId: generatedInvocationId,
      },
    });
  };
}

/** `.ts` wins over `.js`; the worker's esbuild hook loads either. */
async function resolveHandlerFile(
  codeDir: string,
  dir: "actions" | "queries",
  name: string
): Promise<string> {
  const tsPath = path.join(codeDir, dir, `${name}.ts`);
  try {
    if ((await fs.stat(tsPath)).isFile()) return tsPath;
  } catch {
    /* no .ts source — fall back to .js */
  }
  return path.join(codeDir, dir, `${name}.js`);
}

function manifestErrorToResult(appId: string, err: unknown): ToolErrorResult {
  if (err instanceof ManifestError) {
    return errorResult(
      "INVALID_MANIFEST",
      `app "${appId}" manifest: ${err.message}`,
      err.path
    );
  }
  return errorResult(
    "INVALID_MANIFEST",
    `app "${appId}" manifest: ${err instanceof Error ? err.message : String(err)}`
  );
}

// ─── HTTP-status mapping for the app RPC routes (#505) ───

export function statusForToolError(code: ToolErrorCode): number {
  switch (code) {
    case "UNKNOWN_APP":
    case "UNKNOWN_ACTION":
    case "UNKNOWN_QUERY":
      return 404;
    case "WRONG_KIND":
    case "INVALID_INPUT":
      return 400;
    case "INVALID_MANIFEST":
      return 500;
    case "NO_ACTIVE_VERSION":
      return 503;
    case "HANDLER_ERROR":
      return 500;
    case "GATEWAY_BUSY":
      return 503;
  }
}
