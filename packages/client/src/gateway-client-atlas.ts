/* Vault Atlas client (#441): census, graph, pulse, Browse. Split from vault client. */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  nonJsonError,
  readJson,
} from "./gateway-client-core.js";

/** One table in the Kinds census — rows always; bytes under dbstat. */
export interface AtlasCensusTable {
  logical: string;
  physical: string;
  table: string;
  label: string;
  rows: number;
  bytes: number | null;
  pages: number | null;
}

export interface AtlasCensusPack {
  pack: string;
  packLabel: string;
  packKind: "ontology" | "machinery";
  file: "vault" | "journal";
  tables: AtlasCensusTable[];
  rows: number;
  bytes: number | null;
}

export interface AtlasCensusPayload {
  generatedAt: string;
  method: "dbstat" | "estimate";
  fileBytesTotal: number;
  packs: AtlasCensusPack[];
  totals: {
    rows: number;
    bytes: number | null;
    kinds: number;
    populatedKinds: number;
  };
}

/** Schema FK edge — separate from authored links (FK ≠ core_link). */
export interface AtlasFkEdge {
  fromTable: string;
  fromLogical: string;
  fromPack: string;
  col: string;
  toTable: string;
  toLogical: string | null;
  toPack: string | null;
  notnull: boolean;
  childRows: number;
  fill: number;
  ghost: boolean;
  selfRef: boolean;
}

export interface AtlasGraphNode {
  physical: string;
  logical: string;
  table: string;
  label: string;
  pack: string;
  packKind: "ontology" | "machinery";
  packLabel: string;
  /** Curated display name (People, not core_party); else humanized `label`. */
  friendly?: string;
  /** Curated blurb — ONLY kinds with `ATLAS_KIND_FRIENDLY`. Never fabricated. */
  blurb?: string;
  hopDistance: number | null;
  selfRef: boolean;
}

/** Authored `core_link` aggregation — the separate relation mechanism. */
export interface AtlasAuthoredLink {
  relationConceptId: string;
  relationLabel: string | null;
  fromType: string;
  toType: string;
  count: number;
}

export interface AtlasGraphPayload {
  generatedAt: string;
  center: string;
  nodes: AtlasGraphNode[];
  fkEdges: AtlasFkEdge[];
  authoredLinks: AtlasAuthoredLink[];
  island: string[];
  edgeCount: number;
  centerEdgeCount: number;
  selfRefCount: number;
}

export interface AtlasPulseDay {
  day: string;
  count: number;
}

export interface AtlasPulseSeries {
  entityType: string;
  physical: string | null;
  pack: string | null;
  label: string | null;
  total: number;
  days: AtlasPulseDay[];
}

export interface AtlasPulsePayload {
  generatedAt: string;
  since: string;
  windowDays: number;
  live: true;
  series: AtlasPulseSeries[];
}

export async function vaultAtlasStats(): Promise<AtlasCensusPayload> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/atlas/stats", {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<AtlasCensusPayload>(res, "read atlas stats");
}

export async function vaultAtlasGraph(): Promise<AtlasGraphPayload> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/atlas/graph", {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<AtlasGraphPayload>(res, "read atlas graph");
}

export async function vaultAtlasPulse(): Promise<AtlasPulsePayload> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/atlas/pulse", {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<AtlasPulsePayload>(res, "read atlas pulse");
}

// ─── Browse (#441) ─────
// Reads: owner census. Writes: journalled `atlas.*` with operator provenance.
// Sealed columns refuse writes; machinery is read-only unless `unlockMachinery`.

export interface BrowseTableEntry {
  logical: string;
  physical: string;
  pack: string;
  packLabel: string;
  packKind: "ontology" | "machinery";
  label: string;
  rows: number;
  machinery: boolean;
  singlePk: boolean;
}

export interface BrowseColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: number;
  defaultValue: string | null;
  fkTable: string | null;
  fkColumn: string | null;
  fkLogical: string | null;
  sealed: boolean;
}

export interface BrowseColumnsResult {
  logical: string;
  physical: string;
  columns: BrowseColumn[];
  keysetKey: string;
  displayField: string;
  machinery: boolean;
}

export interface BrowseRowsResult {
  logical: string;
  physical: string;
  rows: Record<string, unknown>[];
  columns: string[];
  nextCursor: string | null;
  orderBy: string;
  dir: "asc" | "desc";
  keysetKey: string;
}

export interface BrowseRowResult {
  logical: string;
  physical: string;
  row: Record<string, unknown>;
  columns: string[];
}

export interface BrowseRefHit {
  id: string;
  display: string;
}

export interface BrowseDependent {
  table: string;
  via: string;
  count: number;
  mechanism: "fk" | "poly";
}

export interface BrowseDependentsResult {
  logical: string;
  physical: string;
  id: string;
  dependents: BrowseDependent[];
  hasEngineDependents: boolean;
  totalRows: number;
}

export async function browseTables(): Promise<BrowseTableEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/atlas/browse/tables", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ tables: BrowseTableEntry[] }>(
    res,
    "browse tables"
  );
  return body.tables;
}

export async function browseColumns(
  table: string
): Promise<BrowseColumnsResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/atlas/browse/columns?table=${enc(table)}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  return readJson<BrowseColumnsResult>(res, "browse columns");
}

export async function browseRows(input: {
  table: string;
  limit?: number;
  after?: string;
  orderBy?: string;
  dir?: "asc" | "desc";
}): Promise<BrowseRowsResult> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams({ table: input.table });
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.after !== undefined) params.set("after", input.after);
  if (input.orderBy !== undefined) params.set("orderBy", input.orderBy);
  if (input.dir !== undefined) params.set("dir", input.dir);
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/atlas/browse/rows?${params.toString()}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  return readJson<BrowseRowsResult>(res, "browse rows");
}

export async function browseRow(
  table: string,
  id: string
): Promise<BrowseRowResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/atlas/browse/row?table=${enc(table)}&id=${enc(id)}`,
    { method: "GET", headers: authHeaders(token) }
  );
  return readJson<BrowseRowResult>(res, "browse row");
}

export async function browseRefSearch(
  table: string,
  query: string
): Promise<BrowseRefHit[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/atlas/browse/ref-search?table=${enc(table)}&query=${enc(query)}`,
    { method: "GET", headers: authHeaders(token) }
  );
  const body = await readJson<{ hits: BrowseRefHit[] }>(
    res,
    "browse ref search"
  );
  return body.hits;
}

export async function browseDependents(
  table: string,
  id: string
): Promise<BrowseDependentsResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/atlas/browse/dependents?table=${enc(table)}&id=${enc(id)}`,
    { method: "GET", headers: authHeaders(token) }
  );
  return readJson<BrowseDependentsResult>(res, "browse dependents");
}

/** Expected 4xx/409 come back as `{ ok:false }`, not an exception. */
export interface BrowseWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  dependents?: BrowseDependent[];
  totalRows?: number;
}

/** Parse 4xx/409 as `{ ok:false }`. Only a non-JSON body throws. */
async function browseWrite(
  path: string,
  input: Record<string, unknown>
): Promise<BrowseWriteResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/atlas/browse/${path}`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw nonJsonError(`browse ${path}`, res.status, text);
  }
  return {
    ok: res.ok && body["ok"] !== false,
    ...(typeof body["id"] === "string" ? { id: body["id"] } : {}),
    ...(typeof body["error"] === "string" ? { error: body["error"] } : {}),
    ...(Array.isArray(body["dependents"])
      ? { dependents: body["dependents"] as BrowseDependent[] }
      : {}),
    ...(typeof body["totalRows"] === "number"
      ? { totalRows: body["totalRows"] }
      : {}),
  };
}

export async function browseInsertRow(input: {
  table: string;
  values: Record<string, unknown>;
  unlockMachinery?: boolean;
}): Promise<BrowseWriteResult> {
  return browseWrite("insert", input);
}

export async function browseUpdateRow(input: {
  table: string;
  id: string;
  set: Record<string, unknown>;
  unlockMachinery?: boolean;
}): Promise<BrowseWriteResult> {
  return browseWrite("update", input);
}

/** Engine-FK dependents refuse with `ok:false` + the dependent payload. */
export async function browseDeleteRow(input: {
  table: string;
  id: string;
  unlockMachinery?: boolean;
}): Promise<BrowseWriteResult> {
  return browseWrite("delete", input);
}

export async function vaultDemoPurge(
  appId?: string
): Promise<{ purged: number; blocked: unknown[] }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/demo${appId ? `/${enc(appId)}` : ""}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    }
  );
  return readJson<{ purged: number; blocked: unknown[] }>(
    res,
    "purge demo data"
  );
}
