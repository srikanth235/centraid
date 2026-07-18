// governance: allow-repo-hygiene file-size-limit dispatcher gained the ctx.vault bridge threading (duaility §12); the follow-up split of validation + envelope helpers into a sibling module is tracked separately
/**
 * Declared-handler dispatcher (issue #107, narrowed by issue #286 phase 2).
 * Every non-chat caller (UI buttons, webhooks, automations) flows through
 * here: reads `app.json`, validates `input` against the declared JSON
 * Schema with Ajv, then hands off to the `handler-runner` worker. That is
 * ALL it routes — the `_sql` built-ins died with the per-app data.sqlite
 * (apps are projections; handlers reach data via ctx.vault only).
 * Errors are MCP-shaped: `{ isError, content, structuredContent }`; the
 * HTTP shim maps `structuredContent.code` to a 4xx/5xx status.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runHandler } from './handler-runner.js';
import type { Registry } from '../registry/registry.js';
import {
  APP_MANIFEST_FILE,
  ManifestError,
  compileSchema,
  findAction,
  findQuery,
  parseManifest,
  type Manifest,
  type ManifestActionEntry,
  type ManifestQueryEntry,
} from '../registry/manifest.js';
import { appDataDir } from '../registry/app-paths.js';
import type { RegistryEntry } from '../types.js';
import type { ValidateFunction } from 'ajv';
import type { VaultBridge } from './vault-bridge.js';

// Result envelopes — MCP-shaped (see header comment).
export type ToolErrorCode =
  | 'UNKNOWN_APP'
  | 'UNKNOWN_ACTION'
  | 'UNKNOWN_QUERY'
  | 'WRONG_KIND'
  | 'INVALID_INPUT'
  | 'INVALID_MANIFEST'
  | 'NO_ACTIVE_VERSION'
  | 'HANDLER_ERROR'
  /**
   * The worker-admission gate refused a slot (issue #351): too many
   * app-handler workers already running/queued. Distinct from
   * HANDLER_ERROR — nothing ran, the caller should just retry shortly.
   */
  | 'GATEWAY_BUSY';

export interface ToolErrorContent {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly path?: string;
}

export interface ToolErrorResult {
  readonly isError: true;
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: ToolErrorContent;
}

export interface ToolSuccessResult {
  readonly isError: false;
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: unknown;
}

export type ToolResult = ToolErrorResult | ToolSuccessResult;

function errorResult(code: ToolErrorCode, message: string, path?: string): ToolErrorResult {
  const structured: ToolErrorContent =
    path !== undefined ? { code, message, path } : { code, message };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function successResult(value: unknown): ToolSuccessResult {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
    structuredContent: value,
  };
}

// ----------------------------------------------------------------------------
// Public input shapes
// ----------------------------------------------------------------------------

export interface CentraidWriteInput {
  readonly app: string;
  readonly action: string;
  readonly input?: unknown;
  /** Durable browser intent; binds every vault invocation to replay-safe ids. */
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

// ----------------------------------------------------------------------------
// Dispatcher
// ----------------------------------------------------------------------------

export interface DispatcherOptions {
  /**
   * The app registry, or a resolver for it. The gateway wires "the ACTIVE
   * vault's registry" (#280) so the dispatch surface follows a vault switch.
   */
  readonly registry: Registry | (() => Registry);
  /** Write-notification callback per app — feeds the `_changes` SSE stream. */
  readonly onWriteFor?: (appId: string) => (tables: string[]) => void;
  /**
   * Code-dir resolver (issue #137). The git store owns all code; this
   * resolves an app id to its live code dir (the materialized `main`
   * worktree). An app it can't resolve is not live. When absent, no app
   * has servable code.
   */
  readonly codeDirOverride?: (appId: string) => Promise<string | undefined>;
  /**
   * Per-app `ctx.vault` bridge factory (duaility §12). Resolves the app id
   * to a host-held executor bound to that app's vault credential. When
   * absent, handler `ctx.vault.*` calls fail closed with VAULT_UNAVAILABLE.
   */
  readonly vaultFor?: (appId: string) => VaultBridge;
}

/**
 * Manifest + compiled per-handler validators, keyed by absolute code
 * dir + mtime so a version swap or dev-watch rewrite invalidates.
 */
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
  private readonly codeDirOverride?: (appId: string) => Promise<string | undefined>;
  private readonly vaultFor?: (appId: string) => VaultBridge;
  private readonly manifestCache = new Map<string, ManifestCacheEntry>();

  constructor(opts: DispatcherOptions) {
    const reg = opts.registry;
    this.registryProvider = typeof reg === 'function' ? reg : () => reg;
    if (opts.onWriteFor) this.onWriteFor = opts.onWriteFor;
    if (opts.codeDirOverride) this.codeDirOverride = opts.codeDirOverride;
    if (opts.vaultFor) this.vaultFor = opts.vaultFor;
  }

  private get registry(): Registry {
    return this.registryProvider();
  }

  // --------- resolution helpers ---------
  private async resolveCodeDir(entry: RegistryEntry): Promise<string | undefined> {
    // Git-store backend (#137): the override resolves an app's live code
    // dir. No override → no servable code.
    return this.codeDirOverride ? this.codeDirOverride(entry.id) : undefined;
  }

  private async loadManifest(codeDir: string): Promise<Manifest> {
    const file = path.join(codeDir, APP_MANIFEST_FILE);
    const stat = await fs.stat(file);
    const cached = this.manifestCache.get(codeDir);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.manifest;
    const text = await fs.readFile(file, 'utf8');
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
    kind: 'action' | 'query',
    name: string,
    schema: Record<string, unknown>,
  ): ValidateFunction {
    const entry = this.manifestCache.get(codeDir);
    if (!entry) return compileSchema(schema);
    const cache = kind === 'action' ? entry.actionValidators : entry.queryValidators;
    let v = cache.get(name);
    if (!v) {
      v = compileSchema(schema);
      cache.set(name, v);
    }
    return v;
  }

  /** Throw away the cache for one app — call when a version is activated. */
  invalidate(codeDir?: string): void {
    if (codeDir === undefined) this.manifestCache.clear();
    else this.manifestCache.delete(codeDir);
  }

  // --------- describe ---------

  // `overrideCodeDir` (read/write/describe): the draft-preview path (#141)
  // runs a session worktree's handlers against the app's live data.
  async describe(input: CentraidDescribeInput, overrideCodeDir?: string): Promise<ToolResult> {
    const { app, action, query } = input;
    if (app === undefined) {
      // No filter — return all apps.
      const out: Array<{
        id: string;
        manifest?: Manifest;
        error?: string;
      }> = [];
      for (const entry of this.registry.list()) {
        try {
          const codeDir = await this.resolveCodeDir(entry);
          if (!codeDir) {
            out.push({ id: entry.id, error: 'no_active_version' });
            continue;
          }
          const manifest = await this.loadManifest(codeDir);
          out.push({ id: entry.id, manifest });
        } catch (err) {
          out.push({
            id: entry.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return successResult({ apps: out });
    }

    const entry = this.registry.get(app);
    if (!entry) {
      return errorResult('UNKNOWN_APP', `app "${app}" is not registered`);
    }
    const codeDir = overrideCodeDir ?? (await this.resolveCodeDir(entry));
    if (!codeDir) {
      return errorResult('NO_ACTIVE_VERSION', `app "${app}" has no active version`);
    }
    let manifest: Manifest;
    try {
      manifest = await this.loadManifest(codeDir);
    } catch (err) {
      return manifestErrorToResult(app, err);
    }

    if (action === undefined && query === undefined) {
      // Whole-app describe: the manifest IS the app's shape — its declared
      // handlers and its vault/ext declarations. There is no per-app
      // SQLite schema to report any more.
      return successResult({ manifest });
    }
    if (action !== undefined) {
      const a = findAction(manifest, action);
      if (!a) {
        return errorResult('UNKNOWN_ACTION', `app "${app}" has no action "${action}"`);
      }
      return successResult({
        app: { id: manifest.id, name: manifest.name, version: manifest.version },
        action: a,
      });
    }
    if (query !== undefined) {
      const q = findQuery(manifest, query);
      if (!q) {
        return errorResult('UNKNOWN_QUERY', `app "${app}" has no query "${query}"`);
      }
      return successResult({
        app: { id: manifest.id, name: manifest.name, version: manifest.version },
        query: q,
      });
    }
    // unreachable
    return successResult(manifest);
  }

  // --------- write (action) ---------

  async write(input: CentraidWriteInput, overrideCodeDir?: string): Promise<ToolResult> {
    const { app: appId, action: actionName, input: handlerInput, intentId } = input;
    if (!appId || !actionName) {
      return errorResult('INVALID_INPUT', 'centraid_write requires { app, action }');
    }
    const entry = this.registry.get(appId);
    if (!entry) {
      return errorResult('UNKNOWN_APP', `app "${appId}" is not registered`);
    }
    // Draft mode: logs land in the override worktree beside the draft code.
    const dataDir = overrideCodeDir ?? appDataDir(entry);
    const codeDir = overrideCodeDir ?? (await this.resolveCodeDir(entry));
    if (!codeDir) {
      return errorResult('NO_ACTIVE_VERSION', `app "${appId}" has no active version`);
    }
    let manifest: Manifest;
    try {
      manifest = await this.loadManifest(codeDir);
    } catch (err) {
      return manifestErrorToResult(appId, err);
    }
    // If the caller mistakenly addressed a query through write, surface
    // WRONG_KIND explicitly — better than UNKNOWN_ACTION which would
    // misleadingly suggest the handler doesn't exist.
    if (findQuery(manifest, actionName) && !findAction(manifest, actionName)) {
      return errorResult(
        'WRONG_KIND',
        `"${actionName}" is a query on app "${appId}" — use centraid_read`,
      );
    }
    const entryDef = findAction(manifest, actionName);
    if (!entryDef) {
      return errorResult('UNKNOWN_ACTION', `app "${appId}" has no action "${actionName}"`);
    }
    const validation = this.validateInput(codeDir, 'action', entryDef, handlerInput);
    if (validation) return validation;

    const outcome = await runHandler({
      app: { id: entry.id, dir: dataDir },
      handlerFile: await resolveHandlerFile(codeDir, 'actions', actionName),
      handlerKind: 'action',
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
    });
    if (!outcome.ok) {
      if (outcome.busy) {
        return errorResult('GATEWAY_BUSY', outcome.error ?? 'gateway busy');
      }
      return errorResult('HANDLER_ERROR', outcome.error ?? 'action handler failed');
    }
    // Action handlers historically return `{ status, body }`. Unwrap so
    // the caller gets the substantive payload — non-2xx becomes a
    // HANDLER_ERROR so the chat / HTTP shim treats it as a failure
    // rather than silently passing the error JSON through.
    const result = (outcome.value ?? null) as { status?: number; body?: unknown } | null;
    if (
      result &&
      typeof result === 'object' &&
      typeof result.status === 'number' &&
      result.status >= 400
    ) {
      const bodyText =
        result.body && typeof result.body === 'object' && 'error' in result.body
          ? String((result.body as { error?: unknown }).error)
          : `action returned status ${result.status}`;
      return errorResult('HANDLER_ERROR', bodyText);
    }
    return successResult(result?.body ?? null);
  }

  // --------- read (query) ---------

  async read(input: CentraidReadInput, overrideCodeDir?: string): Promise<ToolResult> {
    const { app: appId, query: queryName, input: handlerInput } = input;
    if (!appId || !queryName) {
      return errorResult('INVALID_INPUT', 'centraid_read requires { app, query }');
    }
    const entry = this.registry.get(appId);
    if (!entry) {
      return errorResult('UNKNOWN_APP', `app "${appId}" is not registered`);
    }
    const dataDir = overrideCodeDir ?? appDataDir(entry); // draft: logs beside draft code; see write
    const codeDir = overrideCodeDir ?? (await this.resolveCodeDir(entry));
    if (!codeDir) {
      return errorResult('NO_ACTIVE_VERSION', `app "${appId}" has no active version`);
    }
    let manifest: Manifest;
    try {
      manifest = await this.loadManifest(codeDir);
    } catch (err) {
      return manifestErrorToResult(appId, err);
    }
    if (findAction(manifest, queryName) && !findQuery(manifest, queryName)) {
      return errorResult(
        'WRONG_KIND',
        `"${queryName}" is an action on app "${appId}" — use centraid_write`,
      );
    }
    const entryDef = findQuery(manifest, queryName);
    if (!entryDef) {
      return errorResult('UNKNOWN_QUERY', `app "${appId}" has no query "${queryName}"`);
    }
    const validation = this.validateInput(codeDir, 'query', entryDef, handlerInput);
    if (validation) return validation;

    const outcome = await runHandler({
      app: { id: entry.id, dir: dataDir },
      handlerFile: await resolveHandlerFile(codeDir, 'queries', queryName),
      handlerKind: 'query',
      args: {
        params: {},
        // Pass the typed input both as `query` (back-compat with the
        // legacy URL-query handler arg) and as `input` (preferred new
        // name). Most existing handlers either ignore both or destructure
        // `query` — neither breaks.
        query: (handlerInput ?? {}) as Record<string, unknown>,
        input: handlerInput,
      },
      timeoutMs: 10_000,
      ...(this.vaultFor ? { vault: this.vaultFor(appId) } : {}),
    });
    if (!outcome.ok) {
      if (outcome.busy) {
        return errorResult('GATEWAY_BUSY', outcome.error ?? 'gateway busy');
      }
      return errorResult('HANDLER_ERROR', outcome.error ?? 'query handler failed');
    }
    return successResult(outcome.value ?? null);
  }

  // --------- shared validation ---------

  private validateInput(
    codeDir: string,
    kind: 'action' | 'query',
    entry: ManifestActionEntry | ManifestQueryEntry,
    input: unknown,
  ): ToolErrorResult | undefined {
    let validate: ValidateFunction;
    try {
      validate = this.validatorFor(codeDir, kind, entry.name, entry.input);
    } catch (err) {
      return errorResult(
        'INVALID_MANIFEST',
        `manifest ${kind} "${entry.name}" has an invalid input schema: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Treat undefined as "no input" — Ajv expects an explicit value, but
    // a caller that omits `input` for a no-arg handler is ergonomic and
    // the schema typically allows an empty object.
    const data = input === undefined ? {} : input;
    if (validate(data)) return undefined;
    const errs = validate.errors ?? [];
    const first = errs[0];
    const path = first?.instancePath || '';
    const msg = first?.message ?? 'input validation failed';
    return errorResult(
      'INVALID_INPUT',
      `${kind} "${entry.name}" rejected input: ${msg}`,
      path || undefined,
    );
  }
}

/**
 * An app action normally makes one typed vault invocation. Offline retries
 * derive a domain-separated id from the authenticated intent and call
 * ordinal; uncommon multi-command actions therefore get stable, disjoint
 * ids. This keeps a crash after canonical commit but before the HTTP outcome
 * from executing the command twice.
 */
function bindIntentToVaultBridge(bridge: VaultBridge, intentId: string): VaultBridge {
  let invocationIndex = 0;
  return (call) => {
    if (call.op !== 'invoke') return bridge(call);
    // JSON framing makes [intent, ordinal] injective before hashing. The
    // domain prefix prevents these ids colliding with any other future hash
    // lane; hashing keeps arbitrary client ids out of the journal key.
    const generatedInvocationId = `replica:v1:${createHash('sha256')
      .update(JSON.stringify(['centraid.replica-invocation.v1', intentId, invocationIndex]))
      .digest('hex')}`;
    invocationIndex += 1;
    return bridge({
      ...call,
      payload: {
        ...call.payload,
        intentId,
        // The authenticated outer intent owns this idempotency namespace.
        // Never trust a handler-selected id: a random value would execute a
        // second canonical write on every offline retry.
        invocationId: generatedInvocationId,
      },
    });
  };
}

/**
 * Resolve a declared handler's source file, preferring a `.ts` over a `.js`
 * (a TS-authored app ships `.ts` handlers; a builder-generated one ships
 * `.js`). The worker loads whatever it's handed: `.ts` graphs go through the
 * esbuild loader hook the worker registers (worker/runner.ts), `.js` graphs
 * import natively as before. A single extra `stat` per dispatch is negligible
 * beside the worker spawn it precedes; if the `.ts` probe misses we fall
 * straight through to the historical `.js` path — a missing `.js` then surfaces
 * as the same worker "no default export"/load error it always did.
 */
async function resolveHandlerFile(
  codeDir: string,
  dir: 'actions' | 'queries',
  name: string,
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
    return errorResult('INVALID_MANIFEST', `app "${appId}" manifest: ${err.message}`, err.path);
  }
  return errorResult(
    'INVALID_MANIFEST',
    `app "${appId}" manifest: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// ----------------------------------------------------------------------------
// HTTP-status mapping for the `POST /tool/:name` shim.
// ----------------------------------------------------------------------------

/** Map a `ToolErrorCode` to an HTTP status code for the shim. */
export function statusForToolError(code: ToolErrorCode): number {
  switch (code) {
    case 'UNKNOWN_APP':
    case 'UNKNOWN_ACTION':
    case 'UNKNOWN_QUERY':
      return 404;
    case 'WRONG_KIND':
    case 'INVALID_INPUT':
      return 400;
    case 'INVALID_MANIFEST':
      return 500;
    case 'NO_ACTIVE_VERSION':
      return 503;
    case 'HANDLER_ERROR':
      return 500;
    case 'GATEWAY_BUSY':
      return 503;
  }
}

/** Names of the three tools the dispatcher exposes. */
export const TOOL_NAMES = ['centraid_write', 'centraid_read', 'centraid_describe'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.includes(name as ToolName);
}
