import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ReplicaRow,
  ReplicaReadWireResult,
} from "@centraid/client/replica/native";

import type { NativeReadRequest } from "../../lib/replica/native-session";
import { useReplica } from "../replica/ReplicaProvider";
import type { ReplicaContextValue } from "../replica/ReplicaProvider";
import { replicaQueryConnection } from "./replica-query-state";
import type { ReplicaQueryState } from "./replica-query-state";

export { combineReplicaQueryStates } from "./replica-query-state";
export type {
  ReplicaQueryConnection,
  ReplicaQueryState,
} from "./replica-query-state";

function latestSync(scopes: ReplicaContextValue["scopes"]): string | undefined {
  // Hermes in the supported Expo runtime does not expose ES2023 `toSorted`.
  // `flatMap` already returns a fresh array, so the compatibility-safe in-place
  // sort cannot mutate replica state.
  return scopes
    ?.flatMap((scope) => (scope.updatedAt ? [scope.updatedAt] : []))
    .sort((a, b) => b.localeCompare(a))[0];
}

/**
 * Project a wire result into `{ ...values, __rowId }` rows. Pure and exported
 * so the identity-stability contract (one mapped array per underlying result,
 * memoized in the hook) is unit-testable without a renderer.
 */
export function mapReplicaRows(
  result: ReplicaReadWireResult | undefined
): Array<ReplicaRow & { __rowId: string }> {
  return (result?.rows ?? []).map((row) => ({
    ...row.values,
    __rowId: row.rowId,
  }));
}

export function useReplicaQuery(
  appId: string,
  request: NativeReadRequest
): ReplicaQueryState {
  const replica = useReplica();
  const { session } = replica;
  const [result, setResult] = useState<ReplicaReadWireResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  // Monotonic ticket so a slow older read can never overwrite a newer result,
  // and a resolution after unmount is dropped instead of setting state.
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    // Nothing to read without a session; `loading` is derived from the session's
    // presence below, so there is no state to settle here either.
    if (!session) return;
    const ticket = (sequence.current += 1);
    const current = (): boolean =>
      mounted.current && ticket === sequence.current;
    try {
      const next = await session.read(appId, request);
      if (!current()) return;
      setResult(next);
      setError(undefined);
    } catch (caughtError) {
      if (!current()) return;
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
    } finally {
      if (current()) setLoading(false);
    }
  }, [appId, request, session]);

  useEffect(() => {
    if (!session) return;
    void (async () => {
      await refresh();
    })();
    return session.subscribe(appId, () => void refresh());
  }, [appId, refresh, session]);

  // Map once per underlying result — a fresh array identity every render would
  // defeat every downstream memo (a 50k merge/re-sort on each selection tap).
  const rows = useMemo(() => mapReplicaRows(result), [result]);
  const connection = replicaQueryConnection({
    ready: replica.ready,
    hasSession: session !== undefined,
    reachability: replica.reachability,
  });
  const lastSyncedAt = latestSync(replica.scopes);

  return {
    rows,
    loading: connection === "loading" || (session !== undefined && loading),
    connection,
    ...(!session && replica.error ? { unavailableReason: replica.error } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(error ? { error } : {}),
    refresh,
  };
}
