import type {
  ReplicaRow,
  ReplicaReadWireResult,
} from "@centraid/client/replica/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NativeReadRequest } from "../../lib/replica/native-session";
import { useReplica } from "../replica/ReplicaProvider";

export interface ReplicaQueryState {
  rows: Array<ReplicaRow & { __rowId: string }>;
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
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
  const { session } = useReplica();
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

  return {
    rows,
    // Without a session there is nothing in flight — never report "loading".
    loading: session !== undefined && loading,
    ...(error ? { error } : {}),
    refresh,
  };
}
