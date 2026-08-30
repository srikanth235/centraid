// The shell's one stale-while-revalidate cache (#659, doctrine D4): settled
// values outlive the component that fetched them and refetches run BEHIND what
// is on screen. Keying is the caller's job (docs/client-keying.md); the one
// axis this primitive owns is ambient — a gateway or vault change invalidates
// EVERYTHING via `resetQueryCache()`, which the shell's re-scope listener calls
// (never wired here, so this module has no import-time side effects).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { optimisticUpdate } from "./optimisticUpdate.js";
import { Store } from "./store.js";

// ── surviving a reload ──────────────────────────────────────────────────────
//
// Write-through to localStorage is OPT-IN per call site — only the call site
// can judge whether the content may sit in unencrypted browser storage —
// purged by `resetQueryCache()`, and byte-capped.

const PERSIST_NAMESPACE = "queryCache.";

/** Guards against a value that has grown a data-URI thumbnail. */
const PERSIST_MAX_BYTES = 64 * 1024;

/** Write-through keys and their shaping step (`null` = as-is). */
const persisted = new Map<string, ((data: unknown) => unknown) | null>();

interface PersistedRecord<T> {
  at: number;
  data: T;
}

function persistKey(key: string): string {
  return `${PERSIST_NAMESPACE}${key}`;
}

/** Seeds only a key that never settled here, and keeps the record's timestamp
 *  so `staleAfterMs` measures the data's age, not the page's. */
function hydrateQuery<T>(
  key: string,
  shape: ((data: T) => T) | undefined
): void {
  persisted.set(key, (shape as (data: unknown) => unknown) ?? null);
  const entry = entryFor<T>(key);
  if (entry.state.status !== "loading" || entry.settledAt !== 0) return;
  const record = readPersisted<T>(key);
  if (!record) return;
  entry.settledAt = record.at;
  publish(entry, { status: "ready", data: record.data, revalidating: true });
}

function readPersisted<T>(key: string): PersistedRecord<T> | undefined {
  const record = Store.get<PersistedRecord<T> | null>(persistKey(key), null);
  return record && typeof record.at === "number" ? record : undefined;
}

function writePersisted<T>(key: string, value: T): void {
  const shape = persisted.get(key);
  const data = shape ? (shape(value) as T) : value;
  // `JSON.stringify(undefined)` is not a string, so the byte check below throws
  // OUTSIDE the settle handler's try — killing the publish and stranding the
  // key on its hydrated copy.
  if (data === undefined) {
    Store.remove(persistKey(key));
    return;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(data);
  } catch {
    return;
  }
  if (encoded.length > PERSIST_MAX_BYTES) {
    Store.remove(persistKey(key));
    return;
  }
  Store.set(persistKey(key), {
    at: Date.now(),
    data,
  } satisfies PersistedRecord<T>);
}

/** `error` rides ALONGSIDE ready data: a failed revalidation must not destroy
 *  a value already on screen. */
export type QueryState<T> =
  | {
      status: "loading";
      data?: undefined;
      error?: undefined;
      revalidating: boolean;
    }
  | { status: "ready"; data: T; error?: string; revalidating: boolean }
  | { status: "error"; data?: undefined; error: string; revalidating: boolean };

interface Entry<T> {
  state: QueryState<T>;
  settledAt: number;
  inFlight: Promise<void> | null;
  subscribers: Set<() => void>;
}

const LOADING: QueryState<never> = { status: "loading", revalidating: true };

const entries = new Map<string, Entry<unknown>>();

function entryFor<T>(key: string): Entry<T> {
  const existing = entries.get(key);
  if (existing) return existing as Entry<T>;
  const created: Entry<T> = {
    state: LOADING,
    settledAt: 0,
    inFlight: null,
    subscribers: new Set(),
  };
  entries.set(key, created as Entry<unknown>);
  return created;
}

function publish<T>(entry: Entry<T>, state: QueryState<T>): void {
  entry.state = state;
  for (const notify of entry.subscribers) notify();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function revalidateQuery<T>(
  key: string,
  load: () => Promise<T>
): Promise<void> {
  const entry = entryFor<T>(key);
  if (entry.inFlight) return entry.inFlight;
  if (!entry.state.revalidating)
    publish(entry, { ...entry.state, revalidating: true });
  const run = load().then(
    (data) => {
      entry.inFlight = null;
      entry.settledAt = Date.now();
      if (persisted.has(key)) writePersisted(key, data);
      publish(entry, { status: "ready", data, revalidating: false });
    },
    (error: unknown) => {
      entry.inFlight = null;
      entry.settledAt = Date.now();
      publish(
        entry,
        entry.state.status === "ready"
          ? { ...entry.state, revalidating: false, error: messageOf(error) }
          : { status: "error", error: messageOf(error), revalidating: false }
      );
    }
  );
  entry.inFlight = run;
  return run;
}

export function peekQuery<T>(key: string): QueryState<T> | undefined {
  return entries.get(key)?.state as QueryState<T> | undefined;
}

export function writeQuery<T>(key: string, data: T): void {
  const entry = entryFor<T>(key);
  publish(entry, {
    status: "ready",
    data,
    revalidating: entry.state.revalidating,
  });
}

/** On failure the pre-edit value is restored and the error RETHROWN: the caller
 *  owns how the failure reads (fallible-action contract). */
export async function mutateQuery<T>(
  key: string,
  apply: (previous: T) => T,
  commit: () => Promise<unknown>,
  revalidate?: () => Promise<T>
): Promise<void> {
  const entry = entryFor<T>(key);
  await optimisticUpdate<QueryState<T>>({
    read: () => entry.state,
    write: (next) => publish(entry, next),
    apply: (previous) =>
      previous.status === "ready"
        ? { ...previous, data: apply(previous.data) }
        : previous,
    commit,
    ...(revalidate ? { settle: () => revalidateQuery(key, revalidate) } : {}),
  });
}

/** With no prefix, the gateway/vault re-scope hook. */
export function resetQueryCache(prefix?: string): void {
  for (const [key, entry] of entries) {
    if (prefix !== undefined && !key.startsWith(prefix)) continue;
    entry.inFlight = null;
    entry.settledAt = 0;
    publish(entry, LOADING);
    if (entry.subscribers.size === 0) entries.delete(key);
  }
  // Persisted copies go by NAMESPACE, never by iterating `entries`: a value from
  // a vault this session never opened has no entry here.
  Store.removeByPrefix(
    prefix === undefined ? PERSIST_NAMESPACE : persistKey(prefix)
  );
  if (prefix === undefined) persisted.clear();
}

export interface CachedQueryOptions<T = unknown> {
  /** `0` (default) always revalidates — stale-WHILE-revalidate. */
  staleAfterMs?: number;
  /** Opt in to write-through; it still revalidates on mount. */
  persist?: boolean;
  /** Shape the value on its way to storage. Required whenever it holds handles
   *  that cannot survive the context that made them — `URL.createObjectURL` in
   *  Home's photo mosaic — or the fast boot paints broken images. */
  toPersisted?: (data: T) => T;
}

export interface CachedQuery<T> {
  state: QueryState<T>;
  refresh: () => Promise<void>;
  mutate: (
    apply: (previous: T) => T,
    commit: () => Promise<unknown>
  ) => Promise<void>;
}

export function useCachedQuery<T>(
  key: string | null,
  load: () => Promise<T>,
  options: CachedQueryOptions<T> = {}
): CachedQuery<T> {
  // Re-read every commit: the KEY is the identity, not the closure.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const run = useCallback((): Promise<T> => loadRef.current(), []);

  // Before the first snapshot read, never in an effect: an effect runs after
  // paint, which is the one frame of skeleton this exists to remove.
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  if (options.persist === true && key !== null && hydratedKey !== key) {
    setHydratedKey(key);
    hydrateQuery<T>(key, options.toPersisted);
  }

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (key === null) return () => undefined;
      const entry = entryFor<T>(key);
      entry.subscribers.add(onChange);
      return () => {
        entry.subscribers.delete(onChange);
      };
    },
    [key]
  );
  const getSnapshot = useCallback(
    (): QueryState<T> => (key === null ? LOADING : entryFor<T>(key).state),
    [key]
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const staleAfterMs = options.staleAfterMs ?? 0;
  useEffect(() => {
    if (key === null) return;
    const entry = entryFor<T>(key);
    const fresh =
      entry.state.status === "ready" &&
      Date.now() - entry.settledAt < staleAfterMs;
    if (fresh) return;
    void revalidateQuery(key, run);
  }, [key, run, staleAfterMs]);

  const refresh = useCallback(
    () => (key === null ? Promise.resolve() : revalidateQuery(key, run)),
    [key, run]
  );
  const mutate = useCallback(
    (apply: (previous: T) => T, commit: () => Promise<unknown>) =>
      key === null ? Promise.resolve() : mutateQuery(key, apply, commit, run),
    [key, run]
  );

  // REFERENTIALLY STABLE (#883): nothing downstream may move while the data
  // has not.
  return useMemo(() => ({ state, refresh, mutate }), [state, refresh, mutate]);
}
