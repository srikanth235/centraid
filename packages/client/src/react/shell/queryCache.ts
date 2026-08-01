// The shell's one stale-while-revalidate cache (issue #659, doctrine D4).
//
// What it replaces. `useAsyncData` is per-mount and blanks to `loading` on any
// deps change, so three separate things went wrong on every screen that used
// it: leaving a route and coming back refetched cold (the data was thrown away
// with the component), a mutation that bumped a refresh nonce swapped the whole
// screen for a spinner, and every caller reinvented "keep the old data" by
// hand. This module keeps settled values in a module-level store keyed by a
// string, so a value outlives the component that fetched it and a refetch runs
// BEHIND whatever is already on screen.
//
// The model is the gateway switcher (App.tsx's `openGatewayPicker`): paint
// immediately from whatever a prior open cached, then probe and patch rows in
// place as they settle. This generalises that.
//
// Keying is the caller's job and follows docs/client-keying.md: the key names
// the axes the value actually depends on (conversation id, app id + vault,
// scope set), never a display label. The one axis the primitive owns is the
// ambient one — a gateway or vault change invalidates EVERYTHING, because a
// different vault is a different world and a stale-but-shown row from the
// previous one is a correctness bug, not a perf tradeoff. `resetQueryCache()`
// is wired to the shell's existing re-scope listener rather than subscribed
// here, so this module has no import-time side effects and stays testable.
//
// Mutations are optimistic by contract: `mutate` applies a local edit, awaits
// the commit, and restores the pre-edit value if the commit rejects. Callers
// do not await-then-refetch — that is the pattern this replaces.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { optimisticUpdate } from "./optimisticUpdate.js";

/**
 * A key's state. Discriminated so `status === "ready"` narrows `data`, and
 * `error` rides ALONGSIDE ready data: a failed revalidation does not destroy a
 * value that is already on screen.
 */
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

/**
 * Fetch into `key`, at most once concurrently. Returns the in-flight promise so
 * a caller that needs to sequence after it (a mutation's revalidation) can.
 */
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
      publish(entry, { status: "ready", data, revalidating: false });
    },
    (error: unknown) => {
      entry.inFlight = null;
      entry.settledAt = Date.now();
      // A failed revalidation must not destroy a good value: the screen keeps
      // rendering what it had and the error rides alongside. Only a key that
      // never settled reports `error` as its status.
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

/** Current state for a key, without subscribing. `undefined` if never touched. */
export function peekQuery<T>(key: string): QueryState<T> | undefined {
  return entries.get(key)?.state as QueryState<T> | undefined;
}

/** Overwrite a key's value locally (no fetch) — the optimistic write. */
export function writeQuery<T>(key: string, data: T): void {
  const entry = entryFor<T>(key);
  publish(entry, {
    status: "ready",
    data,
    revalidating: entry.state.revalidating,
  });
}

/**
 * Apply an optimistic edit, run the commit, and reconcile.
 *
 * On success the key is revalidated so the server's version replaces the
 * guess. On failure the pre-edit value is restored and the error rethrown, so
 * the caller's own toast/confirm path still owns how the failure reads
 * (docs/coding-standards.md, fallible-action contract).
 */
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
    // A key with nothing settled has nothing to edit optimistically — the
    // commit still runs and the revalidation below brings the first value in.
    apply: (previous) =>
      previous.status === "ready"
        ? { ...previous, data: apply(previous.data) }
        : previous,
    commit,
    ...(revalidate ? { settle: () => revalidateQuery(key, revalidate) } : {}),
  });
}

/**
 * Drop cached values. With no prefix this is the gateway/vault re-scope hook:
 * everything the previous vault answered is wrong now. Subscribers are told, so
 * mounted screens fall back to `loading` and refetch rather than showing the
 * old vault's rows.
 */
export function resetQueryCache(prefix?: string): void {
  for (const [key, entry] of entries) {
    if (prefix !== undefined && !key.startsWith(prefix)) continue;
    entry.inFlight = null;
    entry.settledAt = 0;
    publish(entry, LOADING);
    if (entry.subscribers.size === 0) entries.delete(key);
  }
}

export interface CachedQueryOptions {
  /**
   * Skip the on-mount revalidation while the cached value is younger than
   * this. `0` (the default) always revalidates — stale-WHILE-revalidate, not
   * stale-instead-of.
   */
  staleAfterMs?: number;
}

export interface CachedQuery<T> {
  state: QueryState<T>;
  /** Refetch behind the currently shown data; resolves when it settles. */
  refresh: () => Promise<void>;
  /** Optimistic local edit + commit + reconcile; rejects if the commit does. */
  mutate: (
    apply: (previous: T) => T,
    commit: () => Promise<unknown>
  ) => Promise<void>;
}

/**
 * Subscribe a component to `key`, fetching it if nobody has. A `null` key means
 * "nothing to load yet" and parks in `loading` without fetching.
 */
export function useCachedQuery<T>(
  key: string | null,
  load: () => Promise<T>,
  options: CachedQueryOptions = {}
): CachedQuery<T> {
  // The loader is re-read on every commit so an inline closure does not count
  // as a change — same rule useAsyncData established; the KEY is the identity.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const run = useCallback((): Promise<T> => loadRef.current(), []);

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

  return { state, refresh, mutate };
}
