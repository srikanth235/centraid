import { useCallback, useEffect, useState } from 'react';
import type { ReplicaRow, ReplicaReadWireResult } from '@centraid/client/replica/native';

import { useReplica } from '../replica/ReplicaProvider';
import type { NativeReadRequest } from '../../lib/replica/native-session';

export interface ReplicaQueryState {
  rows: Array<ReplicaRow & { __rowId: string }>;
  loading: boolean;
  error?: string;
  refresh(): Promise<void>;
}

export function useReplicaQuery(appId: string, request: NativeReadRequest): ReplicaQueryState {
  const { session } = useReplica();
  const [result, setResult] = useState<ReplicaReadWireResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!session) {
      setLoading(false);
      return;
    }
    try {
      const next = await session.read(appId, request);
      setResult(next);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [appId, request, session]);

  useEffect(() => {
    void refresh();
    if (!session) return;
    return session.subscribe(appId, () => void refresh());
  }, [appId, refresh, session]);

  return {
    rows: (result?.rows ?? []).map((row) => ({ ...row.values, __rowId: row.rowId })),
    loading,
    ...(error ? { error } : {}),
    refresh,
  };
}
