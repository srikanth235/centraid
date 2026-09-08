/**
 * Per-thread run kernel for a reused handler worker (#922 B3). Both the app
 * and automation runners import this: a THREAD SERVES MANY RUNS, and these
 * four are what that actually means — a fresh abort signal, a fresh handler
 * graph, a scrubbed global, a run budget. They live here so the isolate that
 * installs the sandbox is not the only place the contract can be falsified.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Each run imports the handler under a fresh URL, and Node's module registry
 * never drops one, so the cost of a fresh graph is a registry that grows with
 * the thread's age. Retire before `resourceLimits` would kill a worker
 * MID-RUN and fail a member's request.
 */
export const MAX_RUNS_PER_WORKER = 64;

/** Own keys as of the first scrub, captured so later plants can be deleted. */
export function createGlobalScrubber(): (scope?: object) => void {
  let baseline: Set<PropertyKey> | undefined;
  return (scope: object = globalThis): void => {
    const record = scope as Record<PropertyKey, unknown>;
    if (!baseline) {
      baseline = new Set(Reflect.ownKeys(record));
      return;
    }
    for (const key of Reflect.ownKeys(record)) {
      if (baseline.has(key)) continue;
      try {
        delete record[key];
      } catch {
        /* non-configurable: never ours to remove */
      }
    }
  };
}

/** Query string the taint set and the resolve hook both strip. */
export function handlerImportHref(
  handlerFile: string,
  runOrdinal: number
): string {
  return `${pathToFileURL(handlerFile).href}?centraid-run=${runOrdinal}`;
}

export function runResultFlags(
  sandboxKey: string | undefined,
  runsServed: number
): { sandboxKey?: string; retire?: boolean } {
  return {
    ...(sandboxKey ? { sandboxKey } : {}),
    ...(runsServed >= MAX_RUNS_PER_WORKER ? { retire: true } : {}),
  };
}

export function bindHostFetch(
  hostFetch: typeof globalThis.fetch,
  signal: AbortSignal
): typeof globalThis.fetch {
  return (input, init) => hostFetch(input, { ...init, signal });
}

const SEED_FILE = /(?:^|[\\/])seed\.(?:m?js|tsx?)$/u;

/** A seed's fs grant is scoped to its app dir, so the dir is part of the key. */
export function isAppSeedFile(handlerFile: string): boolean {
  return SEED_FILE.test(handlerFile);
}

export function appRunSandboxKey(handlerFile: string, lane: string): string {
  return isAppSeedFile(handlerFile)
    ? `app-seed:${path.dirname(handlerFile)}`
    : lane;
}

/** Lane plus the roots and runtime dir that scoped the install. */
export function automationRunSandboxKey(
  lane: string,
  roots: readonly string[],
  runtimeDir: string | null | undefined
): string {
  return JSON.stringify([lane, roots, runtimeDir ?? null]);
}

export function handlerHostCtx<Vault>(
  hostFetch: typeof globalThis.fetch,
  signal: AbortSignal,
  vault: Vault
): {
  fetch: typeof globalThis.fetch;
  abortSignal: AbortSignal;
  vault: Vault;
} {
  return {
    fetch: bindHostFetch(hostFetch, signal),
    abortSignal: signal,
    vault,
  };
}

export interface ThreadSession {
  readonly signal: AbortSignal;
  readonly runsServed: number;
  beginRun: () => { runOrdinal: number; signal: AbortSignal };
  abort: (reason?: string) => void;
  scrub: (scope?: object) => void;
  importHref: (handlerFile: string) => string;
  resultFlags: (sandboxKey: string | undefined) => {
    sandboxKey?: string;
    retire?: boolean;
  };
  /** Abort this run's signal and drop pending RPCs — never reject them. */
  finish: (pending: { clear: () => void }) => void;
}

export function createThreadSession(): ThreadSession {
  const scrub = createGlobalScrubber();
  let runsServed = 0;
  let abort = new AbortController();
  return {
    get signal(): AbortSignal {
      return abort.signal;
    },
    get runsServed(): number {
      return runsServed;
    },
    beginRun(): { runOrdinal: number; signal: AbortSignal } {
      runsServed += 1;
      abort = new AbortController();
      return { runOrdinal: runsServed, signal: abort.signal };
    },
    abort(reason?: string): void {
      abort.abort(reason);
    },
    scrub,
    importHref(handlerFile: string): string {
      return handlerImportHref(handlerFile, runsServed);
    },
    resultFlags(sandboxKey: string | undefined): {
      sandboxKey?: string;
      retire?: boolean;
    } {
      return runResultFlags(sandboxKey, runsServed);
    },
    finish(pending: { clear: () => void }): void {
      abort.abort();
      pending.clear();
    },
  };
}
