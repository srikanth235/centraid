import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ReplicaRow,
  ReplicaReadWireResult,
} from "@centraid/client/replica/native";

import { coalesceWork } from "../../lib/coalesce";
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

const REPLICA_INVALIDATION_WINDOW_MS = 120;

function latestSync(scopes: ReplicaContextValue["scopes"]): string | undefined {
  return scopes
    ?.flatMap((scope) => (scope.updatedAt ? [scope.updatedAt] : []))
    .sort((a, b) => b.localeCompare(a))[0];
}

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
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
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
    const coalesced = coalesceWork(refresh, REPLICA_INVALIDATION_WINDOW_MS);
    const unsubscribe = session.subscribe(appId, coalesced.signal);
    return () => {
      coalesced.cancel();
      unsubscribe();
    };
  }, [appId, refresh, session]);

  const rows = useMemo(() => mapReplicaRows(result), [result]);
  const connection = replicaQueryConnection({
    ready: replica.ready,
    hasSession: session !== undefined,
    reachability: replica.reachability,
  });
  const lastSyncedAt = latestSync(replica.scopes);
  const coverage = result?.coverage ?? replica.coverage;

  return {
    rows,
    loading: connection === "loading" || (session !== undefined && loading),
    connection,
    ...(!session && replica.error ? { unavailableReason: replica.error } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(coverage ? { coverage } : {}),
    ...(error ? { error } : {}),
    refresh,
  };
}
