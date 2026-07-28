// The two host adapters the library store needs (issue #599), lifted out of
// app-root.tsx: how a `library` read reaches N scopes on this host, and how a
// refetch is deferred. Both are pure plumbing with no app state, which is why
// they live here rather than inside the mount closure.
import { subscribeReadUpdates } from "./kit.ts";
import type { ScopeReadResult } from "./library-store.ts";
import type { LibraryData } from "./types.ts";

/**
 * Fan the `library` query across scopes. `readAll` is the multi-scope door —
 * settled per scope, so one failing audience never sinks the others. A
 * single-scope host that has no `readAll` (the served bridge, the visual
 * harness mock, an older shell) gets the plain `read` it always had, with its
 * answer attributed to the one scope it was asked for — INCLUDING its live-read
 * subscription, when the host's read carries one: such a read pushes a fresh
 * projection straight from the replica with no round trip, and `onLive` is how
 * that push reaches the store. The multi-scope `readAll` door hands back one
 * settled array rather than N live reads, so a fan-out has no push channel and
 * refetches through the change feed instead.
 */
export async function readLibraryScopes(
  scopeIds: readonly string[],
  input: Record<string, unknown>,
  onLive?: (scopeId: string, data: LibraryData) => void
): Promise<ScopeReadResult[]> {
  const client = window.centraid;
  if (typeof client.readAll === "function") {
    const results = await client.readAll<LibraryData>({
      query: "library",
      input,
      scopes: scopeIds,
    });
    return results.map((result) =>
      result.ok
        ? { scope: result.scope, ok: true, data: result.data }
        : { scope: result.scope, ok: false, error: result.error }
    );
  }
  const reads = scopeIds.map((scopeId) =>
    client.read<LibraryData>({
      query: "library",
      input,
      ...(scopeId ? { scope: scopeId } : {}),
    })
  );
  if (onLive) {
    reads.forEach((read, index) => {
      const scopeId = scopeIds[index]!;
      // One subscription per scope at a time: the previous read's is dropped
      // when its replacement lands, exactly as the pre-#599 single read did.
      liveSubscriptions.get(scopeId)?.();
      const subscription = subscribeReadUpdates<LibraryData>(read, (value) =>
        onLive(scopeId, value)
      );
      liveSubscriptions.set(scopeId, subscription.unsubscribe);
    });
  }
  const settled = await Promise.allSettled(reads);
  return settled.map((result, index): ScopeReadResult => {
    const scope = scopeIds[index]!;
    if (result.status === "fulfilled")
      return { scope, ok: true, data: result.value };
    const reason = result.reason as { message?: string };
    return {
      scope,
      ok: false,
      error: { message: String(reason?.message ?? result.reason) },
    };
  });
}

/** Live-read teardowns by scope; replaced per read, cleared on unmount. */
const liveSubscriptions = new Map<string, () => void>();

/** Drop every live-read subscription. Called when the app unmounts. */
export function stopLiveReads(): void {
  for (const unsubscribe of liveSubscriptions.values()) unsubscribe();
  liveSubscriptions.clear();
}

/** Debounce interval for a refetch, matching the pre-#599 change-feed delay. */
const REFETCH_MS = 200;

/**
 * A per-KEY debounce. One shared debounce would coalesce two different scopes'
 * bursts into a single refetch of whichever ran last; keying by scope keeps
 * each scope's burst on its own clock, which is the whole point of refetching
 * one scope at a time. `debounce` is injected (the kit's, in the app) so this
 * module stays free of the browser kit.
 */
export function createRefetchScheduler(
  debounce: (fn: () => void, ms: number) => () => void
): (key: string, run: () => void) => void {
  const schedulers = new Map<string, () => void>();
  return (key, run) => {
    let scheduled = schedulers.get(key);
    if (!scheduled) {
      scheduled = debounce(run, REFETCH_MS);
      schedulers.set(key, scheduled);
    }
    scheduled();
  };
}
