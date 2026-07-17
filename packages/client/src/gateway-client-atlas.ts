/*
 * Renderer-side client for the Vault Atlas (issue #441 Part B): the Kinds
 * census, the Relations graph, the write pulse, and the Browse editor's
 * read/write surface. Split from `gateway-client-vault.ts` — same owner-act
 * character, its own file so each stays within the repo's file-size cap.
 */

import { auth, authHeaders, doFetch, enc, readJson } from './gateway-client-core.js';

/*
 * The Vault Atlas (issue #441 Part B): three read-only owner census surfaces
 * over the registered ontology. Payload shapes mirror the vault package's
 * `atlas-census.ts` builders — the gateway wraps them verbatim.
 */

/** One table in the Kinds census — rows always, bytes under the dbstat method. */
export interface AtlasCensusTable {
  logical: string;
  physical: string;
  table: string;
  label: string;
  rows: number;
  bytes: number | null;
  pages: number | null;
}

/** One pack (== schema) grouping in the census. */
export interface AtlasCensusPack {
  pack: string;
  packLabel: string;
  packKind: 'ontology' | 'machinery';
  file: 'vault' | 'journal';
  tables: AtlasCensusTable[];
  rows: number;
  bytes: number | null;
}

/** The grouped census payload from `GET /_vault/atlas/stats`. */
export interface AtlasCensusPayload {
  generatedAt: string;
  method: 'dbstat' | 'estimate';
  fileBytesTotal: number;
  packs: AtlasCensusPack[];
  totals: {
    rows: number;
    bytes: number | null;
    kinds: number;
    populatedKinds: number;
  };
}

/** A schema-enforced FK edge — SEPARATE from authored links (FK ≠ core_link). */
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

/** A kind node with its ring placement (hop distance from core_party). */
export interface AtlasGraphNode {
  physical: string;
  logical: string;
  table: string;
  label: string;
  pack: string;
  packKind: 'ontology' | 'machinery';
  packLabel: string;
  hopDistance: number | null;
  selfRef: boolean;
}

/** An authored `core_link` aggregation — the separate relation mechanism. */
export interface AtlasAuthoredLink {
  relationConceptId: string;
  relationLabel: string | null;
  fromType: string;
  toType: string;
  count: number;
}

/** The graph payload from `GET /_vault/atlas/graph`. */
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

/** One sparse per-day write count within the pulse window. */
export interface AtlasPulseDay {
  day: string;
  count: number;
}

/** A per-entity-type write series over the 30-day window. */
export interface AtlasPulseSeries {
  entityType: string;
  physical: string | null;
  pack: string | null;
  label: string | null;
  total: number;
  days: AtlasPulseDay[];
}

/** The pulse payload from `GET /_vault/atlas/pulse`. */
export interface AtlasPulsePayload {
  generatedAt: string;
  since: string;
  windowDays: number;
  live: true;
  series: AtlasPulseSeries[];
}

/** Kinds census — per-pack rows/bytes grouping (issue #441 B1). */
export async function vaultAtlasStats(): Promise<AtlasCensusPayload> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/atlas/stats', {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<AtlasCensusPayload>(res, 'read atlas stats');
}

/** Relations graph — FK edges (with fill) + authored links (issue #441 B2). */
export async function vaultAtlasGraph(): Promise<AtlasGraphPayload> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/atlas/graph', {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<AtlasGraphPayload>(res, 'read atlas graph');
}

/** 30-day per-table write pulse from the journal (issue #441 B1 sparklines). */
export async function vaultAtlasPulse(): Promise<AtlasPulsePayload> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/atlas/pulse', {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<AtlasPulsePayload>(res, 'read atlas pulse');
}

// ---------------------------------------------------------------------------
// The Vault Atlas Browse tab (issue #441 Part B, B3): a vault-aware table
// editor. Reads are owner-trust census over the ontology; writes ride the
// journalled command pipeline gateway-side (atlas.* commands) and record
// operator provenance, so a hand-edit ships in the replica log like any app
// write. Sealed columns read as a placeholder and refuse writes; machinery
// bands are read-only unless `unlockMachinery` is set.
// ---------------------------------------------------------------------------

/** One table row of the Browse picker. */
export interface BrowseTableEntry {
  logical: string;
  physical: string;
  pack: string;
  packLabel: string;
  packKind: 'ontology' | 'machinery';
  label: string;
  rows: number;
  machinery: boolean;
  singlePk: boolean;
}

/** Per-column metadata for the row editor. */
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
  dir: 'asc' | 'desc';
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
  mechanism: 'fk' | 'poly';
}

export interface BrowseDependentsResult {
  logical: string;
  physical: string;
  id: string;
  dependents: BrowseDependent[];
  hasEngineDependents: boolean;
  totalRows: number;
}

/** The whole table picker, grouped ontology-packs-first client-side. */
export async function browseTables(): Promise<BrowseTableEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/atlas/browse/tables', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ tables: BrowseTableEntry[] }>(res, 'browse tables');
  return body.tables;
}

/** Column metadata (type, notnull, pk, FK target, sealed) for one table. */
export async function browseColumns(table: string): Promise<BrowseColumnsResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/atlas/browse/columns?table=${enc(table)}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<BrowseColumnsResult>(res, 'browse columns');
}

/** One keyset-paginated page of rows. Pass `after` from a prior nextCursor. */
export async function browseRows(input: {
  table: string;
  limit?: number;
  after?: string;
  orderBy?: string;
  dir?: 'asc' | 'desc';
}): Promise<BrowseRowsResult> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams({ table: input.table });
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.after !== undefined) params.set('after', input.after);
  if (input.orderBy !== undefined) params.set('orderBy', input.orderBy);
  if (input.dir !== undefined) params.set('dir', input.dir);
  const res = await doFetch(baseUrl, `/centraid/_vault/atlas/browse/rows?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<BrowseRowsResult>(res, 'browse rows');
}

/** One row by primary key (composite pks take a JSON array id). */
export async function browseRow(table: string, id: string): Promise<BrowseRowResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/atlas/browse/row?table=${enc(table)}&id=${enc(id)}`,
    { method: 'GET', headers: authHeaders(token) },
  );
  return readJson<BrowseRowResult>(res, 'browse row');
}

/** Search a FK target table for the reference picker: `{ id, display }` hits. */
export async function browseRefSearch(table: string, query: string): Promise<BrowseRefHit[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/atlas/browse/ref-search?table=${enc(table)}&query=${enc(query)}`,
    { method: 'GET', headers: authHeaders(token) },
  );
  const body = await readJson<{ hits: BrowseRefHit[] }>(res, 'browse ref search');
  return body.hits;
}

/** Rows that reference `(table, id)` — engine FKs + polymorphic dependents. */
export async function browseDependents(table: string, id: string): Promise<BrowseDependentsResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/atlas/browse/dependents?table=${enc(table)}&id=${enc(id)}`,
    { method: 'GET', headers: authHeaders(token) },
  );
  return readJson<BrowseDependentsResult>(res, 'browse dependents');
}

/** The result shape of a Browse write — expected validation failures and the
 * dependent-blocked delete come back as data (`ok:false`), not an exception. */
export interface BrowseWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  dependents?: BrowseDependent[];
  totalRows?: number;
}

/**
 * A Browse write POST. Unlike the read helpers, expected 4xx/409 outcomes
 * (STRICT NOT NULL / CHECK violations, sealed-column and machinery refusals,
 * dependent-blocked deletes) are the write UI's normal case, so the body is
 * parsed regardless of status and returned as `{ ok:false, error, dependents }`
 * rather than thrown. Only a non-JSON body is an exception.
 */
async function browseWrite(
  path: string,
  input: Record<string, unknown>,
): Promise<BrowseWriteResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/atlas/browse/${path}`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`browse ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return {
    ok: res.ok && body['ok'] !== false,
    ...(typeof body['id'] === 'string' ? { id: body['id'] } : {}),
    ...(typeof body['error'] === 'string' ? { error: body['error'] } : {}),
    ...(Array.isArray(body['dependents'])
      ? { dependents: body['dependents'] as BrowseDependent[] }
      : {}),
    ...(typeof body['totalRows'] === 'number' ? { totalRows: body['totalRows'] } : {}),
  };
}

/** Insert a row (journalled operator write). Returns the new row id. */
export async function browseInsertRow(input: {
  table: string;
  values: Record<string, unknown>;
  unlockMachinery?: boolean;
}): Promise<BrowseWriteResult> {
  return browseWrite('insert', input);
}

/** Update a row (journalled operator write). */
export async function browseUpdateRow(input: {
  table: string;
  id: string;
  set: Record<string, unknown>;
  unlockMachinery?: boolean;
}): Promise<BrowseWriteResult> {
  return browseWrite('update', input);
}

/**
 * Delete a row (journalled operator write). A row with engine-FK dependents
 * refuses with `ok:false` and the dependent payload — the caller shows
 * "N rows reference this" before offering a retry.
 */
export async function browseDeleteRow(input: {
  table: string;
  id: string;
  unlockMachinery?: boolean;
}): Promise<BrowseWriteResult> {
  return browseWrite('delete', input);
}

/** Purge demo rows — one app's, or every app's when appId is omitted. */
export async function vaultDemoPurge(
  appId?: string,
): Promise<{ purged: number; blocked: unknown[] }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/demo${appId ? `/${enc(appId)}` : ''}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  return readJson<{ purged: number; blocked: unknown[] }>(res, 'purge demo data');
}
