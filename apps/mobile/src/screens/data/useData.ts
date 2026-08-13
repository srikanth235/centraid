// The Data place's loader (#765).
//
// Three reads open the screen — the census, the graph and the browsable table
// list — and a fourth reads one page of records from whichever kind is being
// browsed. They are settled INDEPENDENTLY: a gateway that serves the census
// but not the graph still shows the kinds it counted, because the alternative
// (one failure sinking the page) would hide facts the gateway did answer.
//
// Only the CENSUS failing is the screen's error state, and its copy is about
// the store rather than the network: this route's job is to open the vault's
// own tables, so a census that will not come back is the reference's "Cannot
// open the store", not a transport problem.
//
// `no-gateway` is not a sixth visual — the screen renders it as the error
// panel with the pairing sentence, exactly as `useInsights`/`useAutomations`
// already treat an unpaired phone as a calm state rather than a fault.

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

/** The browsed kind, its page of records, and whether that page is genuinely
 *  in newest-first order (which decides the caption's own claim). */
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
  /** Switch the record table to another kind, by its logical name. */
  browseKind: (logical: string) => void;
}

function messageOf(reason: unknown): string {
  return reason instanceof GatewayError || reason instanceof Error
    ? reason.message
    : "The gateway did not answer.";
}

/**
 * One page of records, newest first WHERE THAT IS POSSIBLE.
 *
 * The browse route orders by its own keyset key unless told otherwise, and the
 * phone cannot know a table's columns before it has seen a row — there is no
 * columns read in `lib/atlas.ts`. So the first page is asked for plainly, its
 * `columns` are inspected for a write time, and only then (and only if one
 * exists) is the page re-read in descending time order. Two requests, both
 * cheap, in exchange for a caption that is true.
 */
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
  // A records page that will not load leaves the section out; the kinds and
  // the relations above it are not about this table and are unaffected.
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
  // The kind being browsed outlives any one load (a refresh must not throw the
  // member back to the biggest table), so it is a ref the loader reads.
  const wanted = useRef<string | undefined>(initialKind);
  // The current state, readable from a callback that must not re-create itself
  // every time the census changes. Written in an effect rather than during
  // render: a ref touched while rendering is a value React is entitled to
  // discard on a re-render it throws away.
  const latest = useRef<DataState>(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  useEffect(() => {
    void loadData(setState, wanted.current);
  }, []);
  // Switching the active vault re-points every one of these reads at a
  // different store — reload rather than show the previous vault's census.
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
    // Read the new table's page beside the current one; the section keeps
    // showing the kind it is labelled with until the new rows land.
    void readRecords(table)
      .then((browse) =>
        setState((now) => (now.kind === "ready" ? { ...now, browse } : now))
      )
      .catch(() => undefined);
  }, []);

  return { browseKind, refresh, refreshing, state };
}
