// Mobile Vault Atlas client — the read surface behind the Data place (#765).
//
//   GET /centraid/_vault/atlas/stats          → the Kinds census
//   GET /centraid/_vault/atlas/graph          → how the kinds relate
//   GET /centraid/_vault/atlas/browse/tables  → the record tables
//   GET /centraid/_vault/atlas/browse/rows    → one keyset page of records
//
// All four are vault-SCOPED owner census reads (`apiHeaders()` — bearer + the
// active vault), computed on request from the live schema by
// `packages/server/src/routes/vault-routes.ts`. Nothing here is derived,
// cached or estimated on the phone: a count this app shows is a count the
// gateway counted.
//
// The payloads are the vault package's `atlas-census.ts` builders, wrapped
// verbatim by the route. Mobile does not depend on that package (nor on
// `@centraid/client`, which mirrors the same shapes for the shell), so they
// are mirrored here as lean local interfaces — the convention `lib/insights.ts`
// and `lib/gateway.ts` already follow. Fields the phone has no surface for
// (dbstat page counts, BFS ring placement, the write pulse) are deliberately
// absent rather than typed-and-ignored: this file is a promise about what the
// screens can read, not a copy of the wire.

import { apiHeaders, fetchJson, requireGatewayBase } from "./gateway";

/** A pack is a schema. `machinery` packs are the engine's own bookkeeping. */
export type PackKind = "ontology" | "machinery";

/** One kind (== table) in the census. `bytes` is null under the estimate method. */
export interface AtlasKind {
  logical: string;
  physical: string;
  table: string;
  label: string;
  rows: number;
  bytes: number | null;
}

/** One pack's grouping of kinds, with its own totals. */
export interface AtlasPack {
  pack: string;
  packLabel: string;
  packKind: PackKind;
  file: "vault" | "journal";
  tables: AtlasKind[];
  rows: number;
  bytes: number | null;
}

/** `GET /_vault/atlas/stats` — the census the Kinds section reads. */
export interface AtlasCensus {
  generatedAt: string;
  /** How `bytes` was obtained. `estimate` means every byte figure is null. */
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

/** A kind node in the relations graph. `friendly` is the name to show. */
export interface AtlasGraphNode {
  physical: string;
  logical: string;
  label: string;
  pack: string;
  packKind: PackKind;
  /** Curated display name ("People", not "core_party"); always sent. */
  friendly?: string;
  /** Curated one-line description — sent only for hand-described kinds. The
   *  gateway never fabricates one, so an absent blurb means there is none. */
  blurb?: string;
}

/**
 * A schema-enforced foreign key between two kinds. Kept SEPARATE from
 * `AtlasAuthoredLink` because they are different mechanisms: a FK is the
 * schema's own rule, an authored link is something a member (or an app) said.
 */
export interface AtlasFkEdge {
  fromTable: string;
  fromLogical: string;
  col: string;
  toTable: string;
  toLogical: string | null;
  notnull: boolean;
  childRows: number;
  /** Share of child rows that actually carry the reference, 0–1. */
  fill: number;
  selfRef: boolean;
}

/** An aggregated `core_link` relation — the authored half of the graph. */
export interface AtlasAuthoredLink {
  relationConceptId: string;
  relationLabel: string | null;
  fromType: string;
  toType: string;
  count: number;
}

/** `GET /_vault/atlas/graph` — what the How-they-relate section reads. */
export interface AtlasGraph {
  generatedAt: string;
  nodes: AtlasGraphNode[];
  fkEdges: AtlasFkEdge[];
  authoredLinks: AtlasAuthoredLink[];
  edgeCount: number;
}

/** One entry of the record-table picker. */
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

/**
 * One keyset page of records. `rows` are raw column maps — the shape a table
 * editor needs and the only shape the gateway has; a screen picks the columns
 * it shows out of `columns`, in the order the gateway sent them.
 */
export interface BrowseRowsPage {
  logical: string;
  physical: string;
  rows: Record<string, unknown>[];
  columns: string[];
  /** Pass back as `after` for the next page; null at the end. */
  nextCursor: string | null;
  orderBy: string;
  dir: "asc" | "desc";
}

/** Per-kind rows + sizes, grouped by pack (#441's census). */
export async function fetchAtlasCensus(): Promise<AtlasCensus> {
  const base = await requireGatewayBase();
  return fetchJson<AtlasCensus>(`${base}/centraid/_vault/atlas/stats`, {
    headers: apiHeaders(),
    method: "GET",
  });
}

/** FK edges (with fill) + authored links (#441's relations). */
export async function fetchAtlasGraph(): Promise<AtlasGraph> {
  const base = await requireGatewayBase();
  return fetchJson<AtlasGraph>(`${base}/centraid/_vault/atlas/graph`, {
    headers: apiHeaders(),
    method: "GET",
  });
}

/** The record-table picker, in the gateway's own order. */
export async function fetchBrowseTables(): Promise<BrowseTable[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ tables?: BrowseTable[] }>(
    `${base}/centraid/_vault/atlas/browse/tables`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.tables ?? [];
}

/**
 * One page of records from a kind. `limit` is clamped gateway-side, so asking
 * for more than the route's maximum is answered, not refused.
 */
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
