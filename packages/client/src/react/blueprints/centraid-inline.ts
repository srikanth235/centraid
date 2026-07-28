import type { InlineAppModule, InlineScope } from '@centraid/blueprints/apps/inline-types';
// The inline `window.centraid` — the shell-side replacement for the served
// bridge's `w.centraid` client (packages/app-engine bridge-script.ts). Backed
// by the shell replica session: reads run the app's query modules locally
// (inlineQueryCtx), writes go through the replica intent dispatch carrying the
// caller's `intentId` verbatim (#406 dedupe lives in the session/route — never
// re-minted here), and `onChange` is a replica-invalidation subscription mapped
// into the kit's `CentraidChangeDetail` shape.
//
// MULTI-SCOPE (issue #599). An app may be mounted over N scopes at once — the
// member's own scope plus every audience scope they belong to — each backed by
// its OWN replica session. The facade is therefore built from an ordered list of
// scope bindings whose FIRST entry is the primary (the member's own): `read`
// addresses the primary unless told otherwise, `readAll` fans out, `write`
// addresses one named scope and refuses a scope the member cannot write, and
// `onChange` fans in with every event tagged by the scope it came from.
//
// `createInlineCentraidClient` builds the client and writes nothing global;
// `installInlineCentraid` publishes it on `window.centraid` and returns a
// teardown that restores whatever was there before. Only one inline app is
// mounted at a time, so a single module-level install is still enough.
import { appQueryPath } from '@centraid/protocol';

import { auth, authHeaders, doFetch, readJson, VAULT_HEADER } from '../../gateway-client-core.js';
import type { ReplicaShellSession } from '../../replica/shell-session.js';
import type { ReplicaInvalidation } from '../../replica/types.js';
import { authorizeBlobUrl } from './blob-auth.js';
import { runInlineQuery } from './inlineQueryCtx.js';

/** The kit change-feed event shape (blueprints' ambient `CentraidChangeDetail`). */
interface InlineChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
  /** Which mounted scope burst. Apps refetch only this one (issue #599). */
  scope?: string;
}

/** The replica surface one scope binding needs. */
export type InlineScopeSession = Pick<
  ReplicaShellSession,
  'read' | 'search' | 'write' | 'subscribe'
>;

/** One mounted scope: its shell-resolved descriptor and its replica session. */
export interface InlineScopeBinding {
  scope: InlineScope;
  session: InlineScopeSession;
}

/** One scope's answer in a `readAll` fan-out. Never throws — errors are data. */
export type InlineScopeRead<T> =
  | { scope: string; ok: true; data: T }
  | { scope: string; ok: false; error: { code?: string; message: string } };

/** A refusal the app is expected to render, not a crash. */
export class InlineScopeError extends Error {
  constructor(
    readonly code: 'SCOPE_READONLY' | 'UNKNOWN_SCOPE',
    message: string,
  ) {
    super(message);
    this.name = 'InlineScopeError';
  }
}

export interface InlineCentraidClient {
  appId: string;
  /** Mounted scopes, primary (the member's own) first. */
  scopes: InlineScope[];
  read: <T = Record<string, unknown>>(opts: {
    query: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    scope?: string;
  }) => Promise<T>;
  readAll: <T = Record<string, unknown>>(opts: {
    query: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    /** Restrict the fan-out (e.g. "load more" hits only the horizon scopes). */
    scopes?: readonly string[];
  }) => Promise<InlineScopeRead<T>[]>;
  write: <T = unknown>(opts: {
    action: string;
    input?: Record<string, unknown>;
    intentId?: string;
    signal?: AbortSignal;
    scope?: string;
  }) => Promise<T>;
  describe: () => Promise<unknown>;
  onChange: (cb: (detail: InlineChangeDetail) => void) => () => void;
  /** An authed `blob:` URL for a `/_vault/blobs/…` path in one scope. */
  blobUrl: (pathname: string, scope?: string) => Promise<string | null>;
}

/** Codes on which a failed local read escalates to the gateway tool route. */
const FALLBACK_CODES = new Set([
  'ONLINE_ONLY',
  'REPLICA_UNAVAILABLE',
  'REPLICA_NOT_READY',
  'REPLICA_REBOOTSTRAP_REQUIRED',
]);

function canFallbackOnline(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && FALLBACK_CODES.has(code);
}

/**
 * The escalation path when a local read cannot be answered from the replica.
 * It names the scope explicitly for the same reason the replica transport does
 * (see `fetchReplicaForScope`): without it the gateway answers for whichever
 * vault is FOCUSED, so a secondary scope would silently render the primary's
 * rows.
 */
async function gatewayRead(
  appId: string,
  query: string,
  input: Record<string, unknown> | undefined,
  scope: string | undefined,
): Promise<unknown> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, appQueryPath(appId, query), {
    method: 'POST',
    headers: {
      ...authHeaders(token, 'application/json'),
      ...(scope ? { [VAULT_HEADER]: scope } : {}),
    },
    body: JSON.stringify({ input }),
  });
  return readJson<unknown>(res, `read ${query}`);
}

/** Map one replica invalidation into the kit change-feed detail shape. */
function toChangeDetail(invalidation: ReplicaInvalidation, scope: string): InlineChangeDetail {
  return {
    tables: invalidation.entity ? [invalidation.entity] : [],
    source: invalidation.source,
    ...(invalidation.intentId ? { intentId: invalidation.intentId } : {}),
    ...(invalidation.intentState ? { intentState: invalidation.intentState } : {}),
    ts: Date.now(),
    ...(scope ? { scope } : {}),
  };
}

function errorDetail(error: unknown): { code?: string; message: string } {
  const code = (error as { code?: unknown })?.code;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The single-scope shape a pre-#599 caller passes. Its scope id is empty, which
 * every scope-addressed transport reads as "the ambient scope" — exactly the
 * behaviour that path had before.
 */
const AMBIENT_SCOPE: InlineScope = { id: '', label: 'Library', canWrite: true };

export interface CreateInlineCentraidOptions {
  appId: string;
  queries: InlineAppModule['queries'];
  /** Mounted scopes, primary first. Mutually exclusive with `session`. */
  scopes?: readonly InlineScopeBinding[];
  /** Single-scope shorthand (pre-#599 callers and single-scope apps). */
  session?: InlineScopeSession;
  isOnline?: () => boolean;
}

function bindingsOf(options: CreateInlineCentraidOptions): InlineScopeBinding[] {
  if (options.scopes && options.scopes.length > 0) return [...options.scopes];
  if (options.session) return [{ scope: AMBIENT_SCOPE, session: options.session }];
  throw new Error('An inline client needs at least one mounted scope');
}

/**
 * Live controls for a built client, kept OFF the client object so an app can
 * never reach them. The route host hydrates secondary scopes after first paint
 * (issue #599): the primary scope blocks the first render, every audience
 * arrives later through `addInlineScope`.
 */
interface InlineClientControls {
  add: (binding: InlineScopeBinding) => void;
}
const controls = new WeakMap<object, InlineClientControls>();

/**
 * Hydrate one more scope into an already-installed client. Returns false when
 * the object is not a client this module built. Existing `onChange` listeners
 * are extended to the new scope and then told it arrived, so an app refetches
 * exactly the scope that appeared rather than re-reading all of them.
 */
export function addInlineScope(client: unknown, binding: InlineScopeBinding): boolean {
  const control = typeof client === 'object' && client ? controls.get(client) : undefined;
  if (!control) return false;
  control.add(binding);
  return true;
}

/** Build the inline client for one app over N scopes. Writes nothing global. */
export function createInlineCentraidClient(
  options: CreateInlineCentraidOptions,
): InlineCentraidClient {
  const { appId, queries } = options;
  const bindings = bindingsOf(options);
  const byId = new Map(bindings.map((binding) => [binding.scope.id, binding]));
  const primary = bindings[0]!;
  // Live `onChange` registrations, so a scope hydrated later still reaches
  // listeners that subscribed before it existed.
  const listeners = new Set<{
    cb: (detail: InlineChangeDetail) => void;
    stops: Map<string, () => void>;
  }>();
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));

  const bindingFor = (scope: string | undefined): InlineScopeBinding => {
    if (scope === undefined) return primary;
    const binding = byId.get(scope);
    if (!binding) throw new InlineScopeError('UNKNOWN_SCOPE', `${scope} is not mounted`);
    return binding;
  };

  const subscribe = (
    cb: (detail: InlineChangeDetail) => void,
    binding: InlineScopeBinding,
  ): (() => void) =>
    binding.session.subscribe(appId, undefined, (invalidations) =>
      invalidations.forEach((invalidation) => cb(toChangeDetail(invalidation, binding.scope.id))),
    );

  const readIn = async <T>(
    binding: InlineScopeBinding,
    opts: {
      query: string;
      input?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<T> => {
    const module = queries[opts.query];
    if (!module) throw new Error(`Unknown query: ${opts.query}`);
    try {
      return (await runInlineQuery(module, {
        session: binding.session,
        appId,
        ...(opts.input ? { input: opts.input } : {}),
        isOnline,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) as T;
    } catch (error) {
      if (!canFallbackOnline(error)) throw error;
      return (await gatewayRead(appId, opts.query, opts.input, binding.scope.id)) as T;
    }
  };

  const client: InlineCentraidClient = {
    appId,
    // The SAME array the app holds: hydrating a scope pushes into it, so an
    // app that captured `client.scopes` sees the audience appear.
    scopes: bindings.map((binding) => binding.scope),

    // `async` deliberately: an unmounted-scope refusal must REJECT like every
    // other read failure, not throw synchronously out of the call site.
    async read<T>(opts: {
      query: string;
      input?: Record<string, unknown>;
      signal?: AbortSignal;
      scope?: string;
    }) {
      return readIn<T>(bindingFor(opts.scope), opts);
    },

    /**
     * Fan a query across scopes. Settled per scope: one audience being
     * unreachable, unmigrated, or denied must never blank the whole surface, so
     * its failure rides back as an entry the app can render beside live data.
     */
    async readAll<T>(opts: {
      query: string;
      input?: Record<string, unknown>;
      signal?: AbortSignal;
      scopes?: readonly string[];
    }) {
      const targets = opts.scopes
        ? bindings.filter((binding) => opts.scopes!.includes(binding.scope.id))
        : bindings;
      const settled = await Promise.allSettled(targets.map((binding) => readIn<T>(binding, opts)));
      return settled.map((result, index): InlineScopeRead<T> => {
        const scope = targets[index]!.scope.id;
        return result.status === 'fulfilled'
          ? { scope, ok: true, data: result.value }
          : { scope, ok: false, error: errorDetail(result.reason) };
      });
    },

    async write<T>(opts: {
      action: string;
      input?: Record<string, unknown>;
      intentId?: string;
      signal?: AbortSignal;
      scope?: string;
    }) {
      const binding = bindingFor(opts.scope);
      // A read-only audience is refused HERE rather than at the gateway: the
      // app gets a typed code it can turn into a disabled control, instead of a
      // 403 after the user already committed to the action.
      if (!binding.scope.canWrite) {
        throw new InlineScopeError(
          'SCOPE_READONLY',
          `You can view ${binding.scope.label}, but not add to it.`,
        );
      }
      const result = await binding.session.write(appId, {
        action: opts.action,
        input: (opts.input ?? {}) as never,
        ...(opts.intentId ? { intentId: opts.intentId } : {}),
      });
      // Shape the intent outcome into the `VaultOutcome` the kit narrates: the
      // durable intentId is the app's `invocationId` (pending-add key), and any
      // handler output rides through unchanged.
      const outcome = result as {
        intentId: string;
        status: string;
        reason?: string;
        output?: unknown;
      };
      return {
        status: outcome.status,
        invocationId: outcome.intentId,
        ...(outcome.reason ? { reason: outcome.reason, message: outcome.reason } : {}),
        ...(outcome.output === undefined ? {} : { output: outcome.output }),
      } as T;
    },

    describe() {
      // Manifests ship in the shell bundle; no inline app reads describe on the
      // render path today, so answer with an empty descriptor rather than a
      // network round-trip (issue #505 surface inventory).
      return Promise.resolve({ commands: [] });
    },

    onChange(cb) {
      const registration = { cb, stops: new Map<string, () => void>() };
      listeners.add(registration);
      for (const binding of bindings)
        registration.stops.set(binding.scope.id, subscribe(cb, binding));
      return () => {
        listeners.delete(registration);
        for (const stop of registration.stops.values()) stop();
      };
    },

    blobUrl(pathname, scope) {
      const id = scope ?? primary.scope.id;
      return authorizeBlobUrl(pathname, id || undefined);
    },
  };

  controls.set(client, {
    add(binding) {
      if (byId.has(binding.scope.id)) return;
      bindings.push(binding);
      byId.set(binding.scope.id, binding);
      client.scopes.push(binding.scope);
      for (const registration of listeners) {
        registration.stops.set(binding.scope.id, subscribe(registration.cb, binding));
        // Announce the arrival on the same channel a burst uses, tagged with
        // the new scope — the app's existing per-scope refetch handles it, and
        // nothing has to re-read the scopes that were already painted.
        registration.cb({
          source: 'scope-added',
          scope: binding.scope.id,
          ts: Date.now(),
        });
      }
    },
  });
  return client;
}

export interface InstallInlineCentraidOptions extends CreateInlineCentraidOptions {
  /** Test seam for the window the client is published on. */
  target?: { centraid?: unknown };
  /**
   * The client that was published. The route host keeps it so later scope
   * hydration extends THIS client rather than whatever is on `window` by then
   * (a remount installs its own).
   */
  onInstalled?: (client: InlineCentraidClient) => void;
}

/** Install `window.centraid` for one inline app mount; returns the teardown. */
export function installInlineCentraid(options: InstallInlineCentraidOptions): () => void {
  const target = (options.target ?? (window as unknown)) as {
    centraid?: unknown;
  };
  const previous = target.centraid;
  const client = createInlineCentraidClient(options);
  target.centraid = client;
  options.onInstalled?.(client);
  return () => {
    // Only restore if we are still the installed client: a remount (a new scope
    // set) installs its own client first, and clobbering that with a stale
    // `previous` would leave the fresh mount without a client at all.
    if (target.centraid === client) target.centraid = previous;
  };
}
