import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchAtlasCensus,
  fetchAtlasGraph,
  fetchBrowseRows,
  fetchBrowseTables,
} from "../../lib/atlas";
import type {
  AtlasCensus,
  AtlasGraph,
  BrowseRowsPage,
  BrowseTable,
} from "../../lib/atlas";
import { GatewayError, resolveGatewayBase } from "../../lib/gateway";
import { subscribeVaultLinks } from "../../lib/vault-links";
import { RECORD_PAGE, pickBrowseTable, timeColumn } from "./data-model";

export interface BrowseView {
  table: BrowseTable;
  page: BrowseRowsPage;
  newestFirst: boolean;
}

export type DataState =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      census: AtlasCensus;
      graph?: AtlasGraph;
      tables: BrowseTable[];
      browse?: BrowseView;
    };

export interface UseData {
  state: DataState;
  refreshing: boolean;
  refresh: () => Promise<void>;
  browseKind: (logical: string) => void;
}

function messageOf(reason: unknown): string {
  return reason instanceof GatewayError || reason instanceof Error
    ? reason.message
    : "The gateway did not answer.";
}

async function readRecords(table: BrowseTable): Promise<BrowseView> {
  const first = await fetchBrowseRows({
    limit: RECORD_PAGE,
    table: table.logical,
  });
  const orderBy = timeColumn(first.columns);
  if (!orderBy) return { newestFirst: false, page: first, table };
  const newest = await fetchBrowseRows({
    dir: "desc",
    limit: RECORD_PAGE,
    orderBy,
    table: table.logical,
  });
  return { newestFirst: true, page: newest, table };
}

async function loadData(
  setState: (next: DataState) => void,
  wanted: string | undefined
): Promise<void> {
  const base = await resolveGatewayBase().catch(() => undefined);
  if (!base) {
    setState({ kind: "no-gateway" });
    return;
  }
  const [censusRes, graphRes, tablesRes] = await Promise.allSettled([
    fetchAtlasCensus(),
    fetchAtlasGraph(),
    fetchBrowseTables(),
  ]);
  if (censusRes.status === "rejected") {
    setState({ kind: "error", message: messageOf(censusRes.reason) });
    return;
  }
  const tables = tablesRes.status === "fulfilled" ? tablesRes.value : [];
  const graph = graphRes.status === "fulfilled" ? graphRes.value : undefined;
  const table = pickBrowseTable(tables, wanted);
  const browse = table
    ? await readRecords(table).catch(() => undefined)
    : undefined;
  setState({
    kind: "ready",
    census: censusRes.value,
    tables,
    ...(graph ? { graph } : {}),
    ...(browse ? { browse } : {}),
  });
}

export function useData(initialKind?: string): UseData {
  const [state, setState] = useState<DataState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const wanted = useRef<string | undefined>(initialKind);
  const latest = useRef<DataState>(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  useEffect(() => {
    void loadData(setState, wanted.current);
  }, []);
  useEffect(
    () => subscribeVaultLinks(() => void loadData(setState, wanted.current)),
    []
  );

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await loadData(setState, wanted.current);
    setRefreshing(false);
  }, []);

  const browseKind = useCallback((logical: string): void => {
    wanted.current = logical;
    const current = latest.current;
    if (current.kind !== "ready") return;
    const table = pickBrowseTable(current.tables, logical);
    if (!table || table.logical === current.browse?.table.logical) return;
    void readRecords(table)
      .then((browse) =>
        setState((now) => (now.kind === "ready" ? { ...now, browse } : now))
      )
      .catch(() => undefined);
  }, []);

  return { browseKind, refresh, refreshing, state };
}
