import { subscribeReadUpdates } from "@centraid/design/elements";

import type { ScopeReadResult } from "./library-store.ts";
import type { LibraryData } from "./types.ts";

/**
 * Fan the `library` query across scopes via `readAll`, settled per scope so
 * one failing audience never sinks the others; hosts without `readAll` fall
 * back to per-scope `read` + live subscription (`onLive`). `readAll` has no
 * push channel — refetches go through the change feed.
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
      // One live subscription per scope at a time: the new read replaces the old.
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

/** Drop every live-read subscription. */
export function stopLiveReads(): void {
  for (const unsubscribe of liveSubscriptions.values()) unsubscribe();
  liveSubscriptions.clear();
}

/** Matches the pre-#599 change-feed delay. */
const REFETCH_MS = 200;

/** Per-key debounce: a shared one would coalesce distinct scopes' bursts into
 *  a refetch of whichever ran last. `debounce` injected — no browser kit here. */
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
