// The Storage screen's data (issue #711), page-side — the `createPeople`
// (people.ts) shape applied to the custody rollup.
//
// LOADED LAZILY, like the People roster and the duplicate clusters: this is a
// destination in the More sheet, not part of the timeline's refresh path, and
// the rollup only changes when the gateway's standing blob sweep runs. Reading
// it on every library refresh would be a read per scope per repaint for a
// number that moves once a sweep.
//
// MULTI-SCOPE, like the timeline (issue #599): the member's own library and
// every audience they belong to each hold their own bytes and their own sweep,
// so each is asked, and a scope that cannot answer is NAMED rather than
// silently folded in as empty (storage-model.ts's `unread`). The fan-out door
// is `readAll` where the host has one; a single-scope host keeps the plain
// `read` it always had.
import { mountedScopes } from "../_shared/scope-kit.ts";
import type { StorageRollup } from "./queries/storage.ts";
import { custodyFacts } from "./storage-model.ts";
import type { CustodyFacts, ScopeRollup } from "./storage-model.ts";

/** What `queries/storage.ts` answers with. */
interface StorageData {
  rollup?: StorageRollup;
}

export interface CustodyStore {
  /** Load once. A no-op while loaded or in flight. */
  ensureLoaded: () => Promise<void>;
  /**
   * The folded facts, or null while nothing has been read yet. Null is NOT the
   * same as "nothing is counted": the view distinguishes "still loading" from
   * "the gateway has never swept", and only the store can tell them apart.
   */
  facts: () => CustodyFacts | null;
  /** Force the next visit to re-read — a sweep may have run since. */
  invalidate: () => void;
}

/** Ask every mounted scope for its rollup, settled per scope. */
async function readScopes(): Promise<ScopeRollup[]> {
  const scopes = mountedScopes();
  const client = window.centraid;
  if (typeof client.readAll === "function") {
    const results = await client.readAll<StorageData>({
      query: "storage",
      input: {},
      scopes: scopes.map((scope) => scope.id),
    });
    return results.map((result, index) => ({
      label: scopes[index]!.label,
      rollup: result.ok ? (result.data.rollup ?? null) : null,
    }));
  }
  const settled = await Promise.allSettled(
    scopes.map((scope) =>
      client.read<StorageData>({
        query: "storage",
        input: {},
        ...(scope.id ? { scope: scope.id } : {}),
      })
    )
  );
  return settled.map((result, index) => ({
    label: scopes[index]!.label,
    rollup:
      result.status === "fulfilled" ? (result.value.rollup ?? null) : null,
  }));
}

export function createCustody({
  onData,
}: {
  onData: () => void;
}): CustodyStore {
  let facts: CustodyFacts | null = null;
  let loading = false;

  async function ensureLoaded(): Promise<void> {
    if (facts != null || loading) return;
    loading = true;
    // A read that throws outright (the whole fan-out failed, not one scope)
    // still produces facts — every scope reads as UNREAD, which the screen
    // renders as "did not answer" rather than as a library of nothing.
    let scopes: ScopeRollup[];
    try {
      scopes = await readScopes();
    } catch {
      scopes = mountedScopes().map((scope) => ({
        label: scope.label,
        rollup: null,
      }));
    }
    facts = custodyFacts(scopes);
    loading = false;
    onData();
  }

  return {
    ensureLoaded,
    facts: () => facts,
    invalidate: () => {
      facts = null;
    },
  };
}
