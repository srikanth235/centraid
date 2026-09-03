import { useCallback, useState } from "react";

import { useReplica } from "./ReplicaProvider";

export function useReplicaRefresh(): {
  refreshing: boolean;
  refreshNow: () => void;
} {
  const { refresh } = useReplica();
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = useCallback(() => {
    if (!refresh || refreshing) return;
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  }, [refresh, refreshing]);
  return { refreshing, refreshNow };
}
