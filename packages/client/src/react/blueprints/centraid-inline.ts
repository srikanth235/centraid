// The inline `window.centraid` — the shell-side replacement for the served
// bridge's `w.centraid` client (packages/app-engine bridge-script.ts). Backed
// by the shell replica session: reads run the app's query modules locally
// (inlineQueryCtx), writes go through the replica intent dispatch carrying the
// caller's `intentId` verbatim (#406 dedupe lives in the session/route — never
// re-minted here), and `onChange` is a replica-invalidation subscription mapped
// into the kit's `CentraidChangeDetail` shape.
//
// Only one inline app is mounted at a time, so the client is a single
// module-level install: `installInlineCentraid` publishes `window.centraid` and
// returns a teardown that restores whatever was there before.
import { appQueryPath } from '@centraid/protocol';
import { auth, authHeaders, doFetch, readJson } from '../../gateway-client-core.js';
import type { ReplicaShellSession } from '../../replica/shell-session.js';
import type { ReplicaInvalidation } from '../../replica/types.js';
import type { InlineAppModule } from '@centraid/blueprints/apps/inline-types';
import { runInlineQuery } from './inlineQueryCtx.js';

/** The kit change-feed event shape (blueprints' ambient `CentraidChangeDetail`). */
interface InlineChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
}

interface InlineCentraidClient {
  appId: string;
  read<T = Record<string, unknown>>(opts: {
    query: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<T>;
  write<T = unknown>(opts: {
    action: string;
    input?: Record<string, unknown>;
    intentId?: string;
    signal?: AbortSignal;
  }): Promise<T>;
  describe(): Promise<unknown>;
  onChange(cb: (detail: InlineChangeDetail) => void): () => void;
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

async function gatewayRead(
  appId: string,
  query: string,
  input: Record<string, unknown> | undefined,
): Promise<unknown> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, appQueryPath(appId, query), {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ input }),
  });
  return readJson<unknown>(res, `read ${query}`);
}

/** Map one replica invalidation into the kit change-feed detail shape. */
function toChangeDetail(invalidation: ReplicaInvalidation): InlineChangeDetail {
  return {
    tables: invalidation.entity ? [invalidation.entity] : [],
    source: invalidation.source,
    ...(invalidation.intentId ? { intentId: invalidation.intentId } : {}),
    ...(invalidation.intentState ? { intentState: invalidation.intentState } : {}),
    ts: Date.now(),
  };
}

export interface InstallInlineCentraidOptions {
  appId: string;
  session: Pick<ReplicaShellSession, 'read' | 'search' | 'write' | 'subscribe'>;
  queries: InlineAppModule['queries'];
  isOnline?: () => boolean;
  /** Test seam for the window the client is published on. */
  target?: { centraid?: unknown };
}

/** Install `window.centraid` for one inline app; returns the teardown. */
export function installInlineCentraid(options: InstallInlineCentraidOptions): () => void {
  const { appId, session, queries } = options;
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const target = (options.target ?? (window as unknown)) as { centraid?: unknown };
  const previous = target.centraid;

  const client: InlineCentraidClient = {
    appId,
    async read<T>(opts: { query: string; input?: Record<string, unknown>; signal?: AbortSignal }) {
      const module = queries[opts.query];
      if (!module) throw new Error(`Unknown query: ${opts.query}`);
      try {
        return (await runInlineQuery(module, {
          session,
          appId,
          ...(opts.input ? { input: opts.input } : {}),
          isOnline,
          ...(opts.signal ? { signal: opts.signal } : {}),
        })) as T;
      } catch (error) {
        if (!canFallbackOnline(error)) throw error;
        return (await gatewayRead(appId, opts.query, opts.input)) as T;
      }
    },
    async write<T>(opts: {
      action: string;
      input?: Record<string, unknown>;
      intentId?: string;
      signal?: AbortSignal;
    }) {
      const result = await session.write(appId, {
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
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      } as T;
    },
    describe() {
      // Manifests ship in the shell bundle; no inline app reads describe on the
      // render path today, so answer with an empty descriptor rather than a
      // network round-trip (issue #505 surface inventory).
      return Promise.resolve({ commands: [] });
    },
    onChange(cb) {
      return session.subscribe(appId, undefined, (invalidations) => {
        for (const invalidation of invalidations) cb(toChangeDetail(invalidation));
      });
    },
  };

  target.centraid = client;
  return () => {
    if (target.centraid === client) target.centraid = previous;
  };
}
