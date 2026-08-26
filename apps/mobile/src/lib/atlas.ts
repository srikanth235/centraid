// Mobile Vault Atlas client (#765). Never derive, cache or estimate here: a
// count shown is a count the gateway counted. The interfaces are a lean local
// mirror — mobile may not depend on `@centraid/vault` or `@centraid/client`.

import { apiHeaders, fetchJson, requireGatewayBase } from "./gateway";

/** `machinery` packs are the engine's own bookkeeping. */
export type PackKind = "ontology" | "machinery";

export interface AtlasKind {
  logical: string;
  physical: string;
  table: string;
  label: string;
  rows: number;
  bytes: number | null;
}

export interface AtlasPack {
  pack: string;
  packLabel: string;
  packKind: PackKind;
  file: "vault" | "journal";
  tables: AtlasKind[];
  rows: number;
  bytes: number | null;
}

export interface AtlasCensus {
  generatedAt: string;
  /** `estimate` means every `bytes` is null. */
  method: "dbstat" | "estimate";
  fileBytesTotal: number;
  packs: AtlasPack[];
  totals: {
    rows: number;
    bytes: number | null;
    kinds: number;
    populatedKinds: number;
  };
}

export interface AtlasGraphNode {
  physical: string;
  logical: string;
  label: string;
  pack: string;
  packKind: PackKind;
  /** The name to show ("People", not "core_party"). */
  friendly?: string;
  /** Absent means none exists; never fabricate one. */
  blurb?: string;
}

/** Keep separate from `AtlasAuthoredLink`: schema rule vs. authored claim. */
export interface AtlasFkEdge {
  fromTable: string;
  fromLogical: string;
  col: string;
  toTable: string;
  toLogical: string | null;
  notnull: boolean;
  childRows: number;
  /** Share of child rows carrying the reference, 0–1. */
  fill: number;
  selfRef: boolean;
}

export interface AtlasAuthoredLink {
  relationConceptId: string;
  relationLabel: string | null;
  fromType: string;
  toType: string;
  count: number;
}

export interface AtlasGraph {
  generatedAt: string;
  nodes: AtlasGraphNode[];
  fkEdges: AtlasFkEdge[];
  authoredLinks: AtlasAuthoredLink[];
  edgeCount: number;
}

export interface BrowseTable {
  logical: string;
  physical: string;
  pack: string;
  packLabel: string;
  packKind: PackKind;
  label: string;
  rows: number;
  machinery: boolean;
  /** False for composite-key tables, whose ids are JSON arrays. */
  singlePk: boolean;
}

/** Render `columns` in the order sent. */
export interface BrowseRowsPage {
  logical: string;
  physical: string;
  rows: Record<string, unknown>[];
  columns: string[];
  /** Pass back as `after`; null at the end. */
  nextCursor: string | null;
  orderBy: string;
  dir: "asc" | "desc";
}

export async function fetchAtlasCensus(): Promise<AtlasCensus> {
  const base = await requireGatewayBase();
  return fetchJson<AtlasCensus>(`${base}/centraid/_vault/atlas/stats`, {
    headers: apiHeaders(),
    method: "GET",
  });
}

export async function fetchAtlasGraph(): Promise<AtlasGraph> {
  const base = await requireGatewayBase();
  return fetchJson<AtlasGraph>(`${base}/centraid/_vault/atlas/graph`, {
    headers: apiHeaders(),
    method: "GET",
  });
}

export async function fetchBrowseTables(): Promise<BrowseTable[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ tables?: BrowseTable[] }>(
    `${base}/centraid/_vault/atlas/browse/tables`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.tables ?? [];
}

/** `limit` is clamped gateway-side: over-asking is answered, not refused. */
export async function fetchBrowseRows(input: {
  table: string;
  limit?: number;
  after?: string;
  orderBy?: string;
  dir?: "asc" | "desc";
}): Promise<BrowseRowsPage> {
  const base = await requireGatewayBase();
  const params = new URLSearchParams({ table: input.table });
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.after !== undefined) params.set("after", input.after);
  if (input.orderBy !== undefined) params.set("orderBy", input.orderBy);
  if (input.dir !== undefined) params.set("dir", input.dir);
  return fetchJson<BrowseRowsPage>(
    `${base}/centraid/_vault/atlas/browse/rows?${params.toString()}`,
    { headers: apiHeaders(), method: "GET" }
  );
}
