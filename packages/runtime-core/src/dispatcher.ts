/**
 * Three-tool invocation dispatcher (issue #107).
 *
 * Replaces the per-handler HTTP routes `/_run` and `/_data/<query>` with
 * exactly three generic tool entry points:
 *
 *   - `centraidWrite({ app, action, input })`  — invokes an action.
 *   - `centraidRead({ app, query, input })`    — invokes a query.
 *   - `centraidDescribe({ app?, action?, query? })` — returns manifest metadata.
 *
 * Every non-chat caller (browser UI button clicks, webhooks, automations)
 * flows through these tools — no per-handler routes, no filesystem-scan
 * dispatch. The dispatcher reads `app.json` from the app's code dir,
 * validates `input` against the declared JSON Schema via Ajv, then hands
 * off to the existing `handler-runner` worker.
 *
 * Errors are returned as MCP-shaped envelopes: `{ isError: true, content,
 * structuredContent }`. `structuredContent` carries `{ code, message,
 * path }` for callers that prefer parsed data (the HTTP shim maps `code`
 * to a 4xx/5xx status; the chat surface forwards the text block).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runHandler } from './handler-runner.js';
import type { Registry } from './registry.js';
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
} from './manifest.js';
import { appCodeDir, appDataDir } from './app-paths.js';
import type { RegistryEntry } from './types.js';
import type { VersionStore } from './version-store.js';
import type { ValidateFunction } from 'ajv';

// ----------------------------------------------------------------------------
// Result envelopes — MCP-shaped so the OpenClaw plugin can return them
// straight back to the agent runtime, and the HTTP shim can translate the
// shape to a 4xx/5xx status.
// ----------------------------------------------------------------------------

export type ToolErrorCode =
  | 'UNKNOWN_APP'
  | 'UNKNOWN_ACTION'
  | 'UNKNOWN_QUERY'
  | 'WRONG_KIND'
  | 'INVALID_INPUT'
  | 'INVALID_MANIFEST'
  | 'NO_ACTIVE_VERSION'
  | 'HANDLER_ERROR';

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
  readonly registry: Registry;
  readonly versions: VersionStore;
  /**
   * Closure that returns a write-notification callback for an app. The
   * runtime threads its `changeBus` through this so action handlers fire
   * the per-app `/centraid/<id>/_changes` SSE stream.
   */
  readonly onWriteFor?: (appId: string) => (tables: string[]) => void;
}

/**
 * Internal cache entry: a manifest plus its compiled per-handler input
 * validators, keyed by the absolute code dir. We re-key on every call
 * by hashing the codeDir + manifest mtime so a version swap or a
 * dev-watch rewrite invalidates immediately.
 */
interface ManifestCacheEntry {
  readonly codeDir: string;
  readonly mtimeMs: number;
  readonly manifest: Manifest;
  readonly actionValidators: Map<string, ValidateFunction>;
  readonly queryValidators: Map<string, ValidateFunction>;
}

export class Dispatcher {
  private readonly registry: Registry;
  private readonly versions: VersionStore;
  private readonly onWriteFor?: (appId: string) => (tables: string[]) => void;
  private readonly manifestCache = new Map<string, ManifestCacheEntry>();

  constructor(opts: DispatcherOptions) {
    this.registry = opts.registry;
    this.versions = opts.versions;
    if (opts.onWriteFor) this.onWriteFor = opts.onWriteFor;
  }

  // --------- resolution helpers ---------

  private async resolveCodeDir(entry: RegistryEntry): Promise<string | undefined> {
    const active = await this.versions.getActiveVersion(entry.path);
    if (!active) return undefined;
    return appCodeDir(entry, active);
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
    if (codeDir === undefined) {
      this.manifestCache.clear();
      return;
    }
    this.manifestCache.delete(codeDir);
  }

  // --------- describe ---------

  async describe(input: CentraidDescribeInput): Promise<ToolResult> {
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
    const codeDir = await this.resolveCodeDir(entry);
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
      return successResult(manifest);
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

  async write(input: CentraidWriteInput): Promise<ToolResult> {
    const { app: appId, action: actionName, input: handlerInput } = input;
    if (!appId || !actionName) {
      return errorResult('INVALID_INPUT', 'centraid_write requires { app, action }');
    }
    const entry = this.registry.get(appId);
    if (!entry) {
      return errorResult('UNKNOWN_APP', `app "${appId}" is not registered`);
    }
    const codeDir = await this.resolveCodeDir(entry);
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
      app: { id: entry.id, dir: appDataDir(entry) },
      handlerFile: path.join(codeDir, 'actions', `${actionName}.js`),
      handlerKind: 'action',
      args: { params: {}, body: handlerInput },
      timeoutMs: 30_000,
      ...(this.onWriteFor ? { onWrite: this.onWriteFor(appId) } : {}),
    });
    if (!outcome.ok) {
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

  async read(input: CentraidReadInput): Promise<ToolResult> {
    const { app: appId, query: queryName, input: handlerInput } = input;
    if (!appId || !queryName) {
      return errorResult('INVALID_INPUT', 'centraid_read requires { app, query }');
    }
    const entry = this.registry.get(appId);
    if (!entry) {
      return errorResult('UNKNOWN_APP', `app "${appId}" is not registered`);
    }
    const codeDir = await this.resolveCodeDir(entry);
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
      app: { id: entry.id, dir: appDataDir(entry) },
      handlerFile: path.join(codeDir, 'queries', `${queryName}.js`),
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
    });
    if (!outcome.ok) {
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
  }
}

/** Names of the three tools the dispatcher exposes. */
export const TOOL_NAMES = ['centraid_write', 'centraid_read', 'centraid_describe'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.includes(name as ToolName);
}
