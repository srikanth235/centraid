import { mountedScopes } from "../_shared/scope-kit.ts";
import type { StorageRollup } from "./queries/storage.ts";
import { custodyFacts } from "./storage-model.ts";
import type { CustodyFacts, ScopeRollup } from "./storage-model.ts";

interface StorageData {
  rollup?: StorageRollup;
}

export interface CustodyStore {
  ensureLoaded: () => Promise<void>;
  facts: () => CustodyFacts | null;
  invalidate: () => void;
}

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
