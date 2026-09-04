import type { PendingOverlayFacts } from "@centraid/blueprints/apps/_shared/pending-overlay";
// governance: allow-repo-hygiene file-size-limit (#738) the mounted-reader transaction boundary keeps attach, schema, overlay, FTS, provenance, and cursor composition in one audited class
import {
  applyOptimisticMutations,
  assertReplicaOrder,
  assertReplicaPage,
  assertReplicaTieCensus,
  DEFAULT_REPLICA_PURPOSE,
  OnlineOnlyError,
  planComposedReplicaRead,
  presentPendingIntentFacts,
  presentPendingIntentMutation,
  replicaFtsMatchExpression,
  replicaPendingSearchMatch,
  replicaPendingSearchRank,
  replicaSearchRequiredColumns,
  replicaLocalSearchSpec,
  ReplicaProtocolError,
  REPLICA_DEFAULT_LOCAL_ROWS,
  REPLICA_DEFAULT_SEARCH_ROWS,
  REPLICA_MAX_LOCAL_ROWS,
  REPLICA_MAX_SEARCH_ROWS,
  trimReplicaPage,
} from "@centraid/client/replica/native";
import type {
  OptimisticMutation,
  ReplicaBindValue,
  ReplicaCursor,
  ReplicaEntitySchema,
  ReplicaIntent,
  ReplicaOverlayBinding,
  ReplicaPage,
  ReplicaPlannedRow,
  ReplicaPlanSource,
  ReplicaReadRequest,
  ReplicaRow,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
  ReplicaSqliteDriver,
  ReplicaTieCensusRow,
} from "@centraid/client/replica/native";

import {
  mountedReadDegradation,
  selectMountedScopes,
} from "./mounted-read-scoping";
import type {
  MountedReadDegradation,
  MountedReadResult,
} from "./mounted-read-scoping";
import {
  dedupeReplicaRowsByContent,
  parseStringArray,
  replicaScopeEnvelope,
  storedReplicaEnvelope,
  storedSchema,
} from "./multi-vault-provenance";
import type {
  StoredReplicaRow,
  StoredReplicaRowValues,
} from "./multi-vault-provenance";
import type { NativeReadRequest, NativeSearchRequest } from "./native-session";
import { MAX_MOUNTED_NATIVE_SCOPES } from "./offline-budgets";

/**
 * Columns `dedupeReplicaRowsByContent` collapses on. An entity exposing one
 * merges rows across scopes, which makes a per-scope `LIMIT` unsafe: the
 * duplicate supplying a source badge may sit outside the other scope's page.
 */
const CONTENT_HASH_COLUMNS = ["sha256", "content_sha256", "blob_sha256"];

/**
 * The off-thread read op-sqlite adds on top of the deliberately synchronous
 * `ReplicaSqliteDriver`. On the phone the driver runs on the JS thread, where a
 * 50k-row scan freezes the UI, so prefer this whenever it is present.
 */
interface AsyncReadDriver {
  allAsync?: <T extends object>(
    sql: string,
    bind?: readonly ReplicaBindValue[]
  ) => Promise<T[]>;
}

interface StoredEntitySchemaRow {
  shape_id: string;
  primary_key: string;
  columns_json: string;
  has_unavailable_fields: number;
}

interface ScopedEntitySchemaRow extends StoredEntitySchemaRow {
  scope_index: number;
}

/** One mounted read's overlay: the mutations per scope, and the one sidecar
 *  the rows they project are explained by (#922 G3). */
interface MountedOverlay {
  byScope: Map<number, OptimisticMutation[]>;
  sidecar: Record<string, PendingOverlayFacts>;
}

interface StoredIntentRow {
  record_json: string;
}

interface ReplicaSourceState {
  cursor_epoch: string;
  cursor_seq: number;
  coverage: "partial" | "complete";
}

export interface MountedReplicaScope {
  vaultId: string;
  label: string;
  canWrite: boolean;
  databaseName: string;
  /** Undefined only before the gateway answers, and reads as their own (#711). */
  personal?: boolean;
}

export interface PlacementIntent {
  linkToken: string;
  kind: "add" | "move";
  itemType:
    | "core.collection"
    | "core.document"
    | "core.content_item"
    | "docs.folder"
    | "locker.item"
    | "media.asset"
    | "tally.group";
  itemId: string;
  sourceVaultId: string;
  targetVaultId: string;
}

export interface PlacementRecord extends PlacementIntent {
  status: "queued" | "in-flight" | "executed" | "parked" | "denied" | "failed";
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredPlacement {
  record_json: string;
}

interface SearchRow extends StoredReplicaRow {
  rank: number;
  snippet: string | null;
}

interface ScopedSearchRow extends SearchRow {
  scope_index: number;
}

interface AttachedScope extends MountedReplicaScope {
  alias: string;
}

/**
 * Outbox states an overlay still projects from; `executed` settles the row out.
 * `conflict` is a PRESENTED state (`presentPendingIntentMutation`), not a stored
 * `IntentState`, and stays listed so the SQL filter matches the JS predicate.
 * Bound into `WHERE state IN (…)` so the `replica_intent_outbox_state` index
 * works instead of every read parsing the whole outbox.
 */
const OVERLAY_STATES = [
  "queued",
  "sending",
  "awaiting-change",
  "parked",
  "denied",
  "conflict",
  "failed",
] as const;

/**
 * Ceiling on rows one federated search pulls from the FTS indexes. Rows a
 * pending mutation addresses are composed separately (address-bounded, below),
 * so a large outbox costs a bounded page, never a refused search (#880).
 */
const MAX_SEARCH_FETCH_ROWS = 10_000;

/**
 * One op-sqlite connection with every mounted vault attached. Per-vault
 * sessions remain the only writers; reads and FTS fan-in happen here so
 * changing the visible Vault is a filter change, not a session teardown.
 */
export class MultiVaultReplicaReader {
  readonly #driver: ReplicaSqliteDriver;
  readonly #scopes: AttachedScope[];
  readonly #contentHashed = new Map<string, boolean>();

  constructor(
    driver: ReplicaSqliteDriver,
    scopes: readonly MountedReplicaScope[]
  ) {
    if (scopes.length === 0)
      throw new ReplicaProtocolError("At least one replica scope is required");
    if (scopes.length > MAX_MOUNTED_NATIVE_SCOPES) {
      throw new ReplicaProtocolError(
        `Native replica scope cap is ${MAX_MOUNTED_NATIVE_SCOPES}`
      );
    }
    this.#driver = driver;
    this.#driver.exec(`
      CREATE TABLE IF NOT EXISTS native_placement_outbox (
        link_token TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        target_vault_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS native_placement_outbox_status
        ON native_placement_outbox(status, updated_at);
    `);
    this.#scopes = scopes.map((scope, index) => ({
      ...scope,
      alias: `scope_${index}`,
    }));
    for (const scope of this.#scopes) {
      this.#driver.exec(
        `ATTACH DATABASE ${sqlString(scope.databaseName)} AS ${scope.alias};`
      );
    }
  }

  scopes(): readonly MountedReplicaScope[] {
    return this.#scopes;
  }

  /**
   * One composed plan over every mounted vault (#883 D1). Never re-implement
   * filter, order or limit here: `planComposedReplicaRead` compiles the grammar
   * ONCE and unions one arm per attached database, so the k-way merge across
   * vaults IS that statement's `ORDER BY`, and only the returned page is parsed.
   *
   * Two things stay in JavaScript because no statement can do them: content
   * dedupe across vaults, and mounted provenance composed onto the envelope.
   * `mounted-read-scoping.ts` names what that costs and what it refuses.
   */
  async read(
    appId: string,
    request: NativeReadRequest
  ): Promise<MountedReadResult> {
    const purpose = request.purpose ?? DEFAULT_REPLICA_PURPOSE;
    const mounted = await this.schemasForAll(appId, purpose, request.entity);
    // Provenance is constant per database, so its equalities choose DATABASES
    // rather than rows — and never reach SQL, which has no value for them.
    const selection = selectMountedScopes(request, this.#scopes);
    const schemas = mounted.filter((schema) =>
      selection.vaultIds.has(this.#scopes[schema.scope_index]!.vaultId)
    );
    const shapeId = request.shapeId ?? mounted[0]?.shape_id;
    const dependency = {
      shapeId: shapeId ?? `${appId}:${purpose}`,
      entity: request.entity,
    };
    if (schemas.length === 0) {
      const empty = this.aggregateState();
      return {
        rows: [],
        cursor: empty.cursor,
        dependency,
        coverage: empty.coverage,
      };
    }
    const [overlays, contentHashed] = await Promise.all([
      this.overlaysForAll(appId, request.entity, schemas),
      this.contentHashed(appId, purpose, request.entity),
    ]);
    const bindings = await this.overlayBindings(
      request.entity,
      schemas,
      overlays.byScope
    );
    const schema = mergedSchema(request.entity, schemas);
    const planRequest: ReplicaReadRequest = {
      ...request,
      shapeId: shapeId!,
      where: selection.where,
    };
    const sources: ReplicaPlanSource[] = schemas.map((scoped) => {
      const overlay = bindings.get(scoped.scope_index);
      return {
        table: `${this.#scopes[scoped.scope_index]!.alias}.replica_row`,
        shapeId: scoped.shape_id,
        ...(overlay ? { overlay } : {}),
      };
    });

    const requested = Math.max(
      Math.min(
        request.limit ?? REPLICA_DEFAULT_LOCAL_ROWS,
        REPLICA_MAX_LOCAL_ROWS
      ),
      1
    );
    // Dedupe runs AFTER the statement, so a limit it can collapse is a limit
    // that may drop the duplicate supplying a source badge. Only a content
    // hash lets rows collapse at all; across several vaults the badge is the
    // point, so the page is not pushed and the whole filtered set is read.
    const badgeRisk = contentHashed && schemas.length > 1;
    const degraded: MountedReadDegradation[] = [];
    if (badgeRisk) degraded.push(mountedReadDegradation("content-hash-badges"));
    let page = await this.runPlan(
      schema,
      planRequest,
      sources,
      badgeRisk ? REPLICA_MAX_LOCAL_ROWS : requested
    );
    let planned = page.rows;
    let rows = this.compose(planned, schemas);
    // A short page proves there is nothing more only when nothing was cut off.
    // One vault's own duplicates can collapse a full page; pay for the whole
    // filtered set exactly then, and say so.
    if (
      !badgeRisk &&
      contentHashed &&
      rows.length < requested &&
      planned.length === requested
    ) {
      degraded.push(mountedReadDegradation("dedupe-collapse"));
      page = await this.runPlan(
        schema,
        planRequest,
        sources,
        REPLICA_MAX_LOCAL_ROWS
      );
      planned = page.rows;
      rows = this.compose(planned, schemas);
    }
    const aggregate = this.aggregateState();
    // The plan clamps a caller's limit to its own local ceiling. A page that
    // then fills that ceiling provably has rows behind it, so report it partial
    // rather than letting a capped answer read as the whole mounted plane.
    const clamped =
      (request.limit ?? 0) > REPLICA_MAX_LOCAL_ROWS &&
      planned.length === REPLICA_MAX_LOCAL_ROWS;
    // Two ways this answer hides rows: the statement's own window filled, or
    // dedupe/badge composition left more than the caller asked for. Either one
    // is a truncation the surface must be able to say out loud (#922 0a).
    const truncated = page.truncated || rows.length > requested;
    return {
      rows: rows.slice(0, requested),
      cursor: aggregate.cursor,
      pending: overlays.sidecar,
      dependency: { shapeId: shapeId!, entity: request.entity },
      coverage: clamped ? "partial" : aggregate.coverage,
      ...(degraded.length > 0 ? { degraded } : {}),
      ...(truncated ? { truncated: true, appliedLimit: requested } : {}),
    };
  }

  /** Compile, run and audit one composed page. */
  private async runPlan(
    schema: ReplicaEntitySchema,
    request: ReplicaReadRequest,
    sources: readonly ReplicaPlanSource[],
    limit: number
  ): Promise<ReplicaPage<ReplicaPlannedRow>> {
    const plan = planComposedReplicaRead(
      schema,
      { ...request, limit },
      new Date(),
      sources
    );
    const probed = await this.query<ReplicaPlannedRow>(plan.sql, plan.binds);
    // Escalating rows sort ahead of the whole union, so one page proves every
    // mounted database clean or names the first refusal.
    assertReplicaPage(probed, plan);
    // The order guards ride their own statement since #922 C3, so the mounted
    // reader runs it too — the escalation must not depend on which reader is
    // asking.
    if (plan.orderCensus && probed.length > 0) {
      const census = await this.query<Record<string, number>>(
        plan.orderCensus.sql,
        plan.orderCensus.binds
      );
      assertReplicaOrder(census[0], plan);
    }
    if (plan.tieCensus) {
      const census = await this.query<ReplicaTieCensusRow>(
        plan.tieCensus.sql,
        plan.tieCensus.binds
      );
      if (census[0]) assertReplicaTieCensus(census[0]);
    }
    // The plan over-fetches by one; that probe is the exact evidence the window
    // cut something off, and it never reaches a caller (#922 0a).
    return trimReplicaPage(probed, plan);
  }

  /** The statement's order is the answer's order; dedupe preserves it. */
  private compose(
    planned: readonly ReplicaPlannedRow[],
    schemas: readonly ScopedEntitySchemaRow[]
  ): ReplicaRowEnvelope[] {
    const byIndex = new Map(
      schemas.map((schema) => [schema.scope_index, schema])
    );
    return dedupeReplicaRowsByContent(
      planned.map((row) => {
        const index = row.source_index ?? schemas[0]!.scope_index;
        const scoped = byIndex.get(index) ?? schemas[0]!;
        // Provenance prefixes the identity LAST: intent row ids and canonical
        // primary keys deliberately share the unprefixed domain above it.
        return replicaScopeEnvelope(this.#scopes[index]!, {
          rowId: row.row_id,
          values: JSON.parse(row.payload_json) as ReplicaRow,
          oversizedFields: parseStringArray(row.oversized_json),
          hasUnavailableFields: scoped.has_unavailable_fields === 1,
          ...(row.server_version > 0 ? { rowVersion: row.server_version } : {}),
        });
      }),
      // Equal bytes in two vaults collapse into one badged row, and the
      // statement's order decides which of them arrives first. The canonical
      // source and its badge order stay the MOUNT's, which is the order the
      // vaults switcher shows and the order a write target is chosen in.
      this.#scopes.map((scope) => scope.vaultId)
    );
  }

  /** Federated FTS5: one bounded MATCH per index, ranked and deduped once. */
  async search(
    appId: string,
    request: NativeSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    const purpose = request.purpose ?? DEFAULT_REPLICA_PURPOSE;
    if (this.#scopes.length === 0) {
      return {
        rows: [],
        cursor: { epoch: "mounted", seq: 0 },
        dependency: {
          shapeId: request.shapeId ?? `${appId}:${purpose}`,
          entity: request.entity,
        },
        coverage: "partial",
      };
    }
    if ((request.where?.length ?? 0) > 0) {
      throw new ReplicaProtocolError(
        "Federated replica search does not accept filters"
      );
    }
    const searchSpec = replicaLocalSearchSpec(request.entity);
    const required = replicaSearchRequiredColumns(searchSpec);
    const schemas = await this.schemasForAll(appId, purpose, request.entity);
    const overlays = await this.overlaysForAll(appId, request.entity, schemas);
    const indexed = new Set(required);
    const limit = Math.min(
      Math.max(request.limit ?? REPLICA_DEFAULT_SEARCH_ROWS, 1),
      REPLICA_MAX_SEARCH_ROWS
    );
    // Only a delete or an upsert that touches an INDEXED column can take a
    // canonical hit out of the composed page; every other pending mutation
    // leaves the FTS ranking alone. Over-fetch by that count rather than by the
    // whole outbox, and cap the page: a phone with ten thousand queued writes
    // keeps searching, because rows those writes address are pulled in by id
    // below instead of by inflating the ranked page.
    const displacing = [...overlays.byScope.values()].reduce(
      (count, mutations) =>
        count +
        mutations.filter((mutation) => displaces(mutation, indexed)).length,
      0
    );
    // `+ 1` is the truncation probe (#922 0a): a ranked page of exactly `limit`
    // proves nothing, one hit past the window proves the window cut the answer
    // short. It is dropped before the caller sees it.
    const fetchLimit = Math.min(limit + 1 + displacing, MAX_SEARCH_FETCH_ROWS);
    const match = replicaFtsMatchExpression(request.query);
    const parameters: ReplicaBindValue[] = [];
    const union = this.#scopes
      .map((scope, scopeIndex) => {
        parameters.push(match, fetchLimit, appId, purpose, request.entity);
        return `SELECT ${scopeIndex} AS scope_index,
                       s.shape_id, s.row_id, r.payload_json, r.oversized_json,
                       r.server_version,
                       es.primary_key, es.columns_json,
                       es.has_unavailable_fields, m.cursor_epoch,
                       m.cursor_seq, m.coverage, s.rank AS rank, s.snippet
                  FROM (
                    SELECT shape_id, entity, row_id, rank,
                           snippet(
                             replica_search, -1, '⟦', '⟧', '…', 12
                           ) AS snippet
                      FROM ${scope.alias}.replica_search
                     WHERE replica_search MATCH ?
                     ORDER BY rank
                     LIMIT ?
                  ) AS s
                  JOIN ${scope.alias}.replica_row AS r
                    ON r.shape_id = s.shape_id AND r.entity = s.entity
                   AND r.row_id = s.row_id
                  JOIN ${scope.alias}.replica_entity_schema AS es
                    ON es.shape_id = s.shape_id AND es.entity = s.entity
                  JOIN ${scope.alias}.replica_shape AS sh
                    ON sh.shape_id = s.shape_id
                  JOIN (${cursorSql(scope)}) AS m
                 WHERE sh.app_id = ? AND sh.purpose = ? AND s.entity = ?`;
      })
      .join(" UNION ALL ");
    parameters.push(fetchLimit);
    const combined = await this.query<ScopedSearchRow>(
      `SELECT * FROM (${union}) ORDER BY rank LIMIT ?`,
      parameters
    );
    const hits: ReplicaRowEnvelope[] = [];
    // Pending rows rank ahead of every canonical hit, in scope then composition
    // order. The counter runs across scopes, never striding by the fetch page:
    // a scope composing more pending rows than that page holds would collide.
    let pendingPosition = 0;
    for (const schema of schemas) {
      const scope = this.#scopes[schema.scope_index]!;
      const scopeRows = combined.filter(
        (row) => row.scope_index === schema.scope_index
      );
      const exposed = parseStringArray(schema.columns_json);
      const missing = required.filter((column) => !exposed.includes(column));
      if (missing.length > 0)
        throw new OnlineOnlyError(
          `replica shape does not expose indexed column(s) ${missing.join(", ")}`
        );
      const hitIds = new Set(scopeRows.map((row) => row.row_id));
      const mutations = overlays.byScope.get(schema.scope_index) ?? [];
      const indexedRowIds = new Set(
        mutations
          .filter(
            (mutation) =>
              mutation.op === "upsert" &&
              Object.keys(mutation.values).some((column) => indexed.has(column))
          )
          .map((mutation) => mutation.rowId)
      );
      const addressedIds = [...indexedRowIds].filter(
        (rowId) => !hitIds.has(rowId)
      );
      // oxlint-disable-next-line no-await-in-loop -- keep schemas serial while each bind-limited chunk batch runs in parallel.
      const addressedChunks = await Promise.all(
        Array.from(
          { length: Math.ceil(addressedIds.length / 400) },
          (_, index) => addressedIds.slice(index * 400, (index + 1) * 400)
        ).map((chunk) =>
          this.query<StoredReplicaRow>(
            `SELECT r.shape_id, r.row_id, r.payload_json, r.oversized_json,
                    r.server_version, es.primary_key, es.columns_json,
                    es.has_unavailable_fields, m.cursor_epoch, m.cursor_seq,
                    m.coverage
               FROM ${scope.alias}.replica_row AS r
               JOIN ${scope.alias}.replica_entity_schema AS es
                 ON es.shape_id = r.shape_id AND es.entity = r.entity
               JOIN (${cursorSql(scope)}) AS m
              WHERE r.shape_id = ? AND r.entity = ?
                AND r.row_id IN (${chunk.map(() => "?").join(", ")})`,
            [schema.shape_id, request.entity, ...chunk]
          )
        )
      );
      const addressed = addressedChunks.flat();
      const canonical = [
        ...scopeRows.map((row) =>
          storedReplicaEnvelope(row, {
            _rank: row.rank,
            _snippet: row.snippet ?? "",
          })
        ),
        ...addressed.map((row) => storedReplicaEnvelope(row)),
      ];
      hits.push(
        ...applyOptimisticMutations(
          canonical,
          mutations,
          storedSchema(request.entity, schema)
        )
          .flatMap((row) => {
            if (!indexedRowIds.has(row.rowId))
              return hitIds.has(row.rowId) ? [row] : [];
            const local = replicaPendingSearchMatch(
              row.values,
              searchSpec,
              request.query
            );
            if (!local.matches) return [];
            const rank = replicaPendingSearchRank(pendingPosition);
            pendingPosition += 1;
            return [
              {
                ...row,
                values: { ...row.values, _rank: rank, _snippet: local.snippet },
              },
            ];
          })
          .map((row) => replicaScopeEnvelope(scope, row))
      );
    }
    const ranked = dedupeReplicaRowsByContent(hits).sort(
      (left, right) =>
        Number(left.values._rank ?? 0) - Number(right.values._rank ?? 0)
    );
    const rows = ranked.slice(0, limit);
    const aggregate = this.aggregateState();
    return {
      rows,
      cursor: aggregate.cursor,
      pending: overlays.sidecar,
      dependency: {
        shapeId: request.shapeId ?? `${appId}:${purpose}`,
        entity: request.entity,
      },
      coverage: aggregate.coverage,
      ...(ranked.length > limit
        ? { truncated: true, appliedLimit: limit }
        : {}),
    };
  }

  close(): void {
    this.#driver.close();
  }

  revokeScope(vaultId: string): void {
    const scope = this.#scopes.find(
      (candidate) => candidate.vaultId === vaultId
    );
    if (!scope) return;
    for (const placement of this.placements()) {
      if (
        placement.sourceVaultId === vaultId ||
        placement.targetVaultId === vaultId
      ) {
        this.#driver.run(
          "DELETE FROM native_placement_outbox WHERE link_token = ?",
          [placement.linkToken]
        );
      }
    }
    this.#driver.exec(`DETACH DATABASE ${scope.alias};`);
    this.#scopes.splice(this.#scopes.indexOf(scope), 1);
    // Scope count and the union of shape columns both feed the pushdown plan.
    this.#contentHashed.clear();
  }

  enqueuePlacement(input: PlacementIntent): PlacementRecord {
    const existing = this.placement(input.linkToken);
    if (existing) {
      if (
        JSON.stringify(withoutPlacementState(existing)) !==
        JSON.stringify(input)
      )
        throw new ReplicaProtocolError(
          `Placement token ${input.linkToken} was reused`
        );
      return existing;
    }
    const now = new Date().toISOString();
    const record: PlacementRecord = {
      ...input,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.storePlacement(record);
    return record;
  }

  placements(): PlacementRecord[] {
    return this.#driver
      .all<StoredPlacement>(
        `SELECT record_json FROM native_placement_outbox
          ORDER BY updated_at DESC`
      )
      .map((row) => JSON.parse(row.record_json) as PlacementRecord);
  }

  placement(linkToken: string): PlacementRecord | undefined {
    const row = this.#driver.all<StoredPlacement>(
      "SELECT record_json FROM native_placement_outbox WHERE link_token = ?",
      [linkToken]
    )[0];
    return row ? (JSON.parse(row.record_json) as PlacementRecord) : undefined;
  }

  updatePlacement(record: PlacementRecord): void {
    const current = this.placement(record.linkToken);
    this.storePlacement({
      ...record,
      createdAt: current?.createdAt ?? record.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }

  cancelPlacement(linkToken: string): boolean {
    const record = this.placement(linkToken);
    if (!record || (record.status !== "queued" && record.status !== "parked"))
      return false;
    this.#driver.run(
      "DELETE FROM native_placement_outbox WHERE link_token = ?",
      [linkToken]
    );
    return true;
  }

  dismissPlacement(linkToken: string): void {
    const record = this.placement(linkToken);
    if (!record || record.status === "queued" || record.status === "in-flight")
      return;
    this.#driver.run(
      "DELETE FROM native_placement_outbox WHERE link_token = ?",
      [linkToken]
    );
  }

  /**
   * Each vault's outbox, composed into the JSON value its plan arm binds.
   * Bounded by the MUTATIONS, not the vault: three queued edits cost three rows
   * however large the library is, and the composed value crosses back into
   * SQLite so filter, order and limit still run once over the overlaid set.
   */
  private async overlayBindings(
    entity: string,
    schemas: readonly ScopedEntitySchemaRow[],
    overlays: ReadonlyMap<number, OptimisticMutation[]>
  ): Promise<Map<number, ReplicaOverlayBinding>> {
    const bindings = new Map<number, ReplicaOverlayBinding>();
    await Promise.all(
      schemas.map(async (schema) => {
        const mutations = (overlays.get(schema.scope_index) ?? []).filter(
          (mutation) => mutation.shapeId === schema.shape_id
        );
        if (mutations.length === 0) return;
        const rowIds = [...new Set(mutations.map((item) => item.rowId))];
        const scope = this.#scopes[schema.scope_index]!;
        const chunks = await Promise.all(
          Array.from(
            { length: Math.ceil(rowIds.length / 400) },
            (_unused, index) => rowIds.slice(index * 400, (index + 1) * 400)
          ).map((chunk) =>
            this.query<StoredReplicaRowValues>(
              `SELECT r.row_id, r.payload_json, r.oversized_json,
                      r.server_version, es.has_unavailable_fields
                 FROM ${scope.alias}.replica_row AS r
                 JOIN ${scope.alias}.replica_entity_schema AS es
                   ON es.shape_id = r.shape_id AND es.entity = r.entity
                WHERE r.shape_id = ? AND r.entity = ?
                  AND r.row_id IN (${chunk.map(() => "?").join(", ")})`,
              [schema.shape_id, entity, ...chunk]
            )
          )
        );
        const addressed = chunks
          .flat()
          .map((row) => storedReplicaEnvelope(row));
        bindings.set(schema.scope_index, {
          rowIds: JSON.stringify(rowIds),
          rows: JSON.stringify(
            applyOptimisticMutations(
              addressed,
              mutations,
              storedSchema(entity, schema)
            ).map((row) => ({
              i: row.rowId,
              p: JSON.stringify(row.values),
              o: JSON.stringify(row.oversizedFields),
              v: row.rowVersion ?? 0,
            }))
          ),
        });
      })
    );
    return bindings;
  }

  private schemasForAll(
    appId: string,
    purpose: string,
    entity: string
  ): Promise<ScopedEntitySchemaRow[]> {
    if (this.#scopes.length === 0) return Promise.resolve([]);
    const parameters: ReplicaBindValue[] = [];
    const union = this.#scopes
      .map((scope, scopeIndex) => {
        parameters.push(appId, purpose, entity);
        return `SELECT ${scopeIndex} AS scope_index, es.shape_id,
                       es.primary_key, es.columns_json,
                       es.has_unavailable_fields
                  FROM ${scope.alias}.replica_entity_schema AS es
                  JOIN ${scope.alias}.replica_shape AS sh
                    ON sh.shape_id = es.shape_id
                 WHERE sh.app_id = ? AND sh.purpose = ? AND es.entity = ?`;
      })
      .join(" UNION ALL ");
    return this.query<ScopedEntitySchemaRow>(
      `SELECT * FROM (${union})`,
      parameters
    );
  }

  private async overlaysForAll(
    appId: string,
    entity: string,
    schemas: readonly ScopedEntitySchemaRow[]
  ): Promise<MountedOverlay> {
    const result = new Map<number, OptimisticMutation[]>();
    const sidecar: Record<string, PendingOverlayFacts> = {};
    await Promise.all(
      schemas.map(async (schema) => {
        const scope = this.#scopes[schema.scope_index]!;
        const table = await this.query<{ present: number }>(
          `SELECT 1 AS present FROM ${scope.alias}.sqlite_master
            WHERE type = 'table' AND name = 'replica_intent_outbox' LIMIT 1`,
          []
        );
        if (!table[0]) return;
        // State and app are what SQL can decide: the state column is indexed,
        // and `appId` is a scalar at the top of the stored record. Entity and
        // shape stay in JS because they live inside the record's `optimistic`
        // ARRAY — one intent can address several of them, so no scalar column
        // or path expression answers for the whole row.
        const records = await this.query<StoredIntentRow>(
          `SELECT record_json FROM ${scope.alias}.replica_intent_outbox
            WHERE state IN (${OVERLAY_STATES.map(() => "?").join(", ")})
              AND json_extract(record_json, '$.appId') = ?
            ORDER BY created_order`,
          [...OVERLAY_STATES, appId]
        );
        const mutations = records.flatMap((row) => {
          const intent = JSON.parse(row.record_json) as ReplicaIntent;
          const projected = intent.optimistic
            .filter(
              (mutation) =>
                mutation.entity === entity &&
                mutation.shapeId === schema.shape_id
            )
            .map((mutation) => presentPendingIntentMutation(mutation, intent));
          if (projected.length === 0) return projected;
          // The rows carry the intent; the sidecar carries what is happening to
          // it, once per read rather than once per row (#922 G3).
          const facts = presentPendingIntentFacts(intent);
          if (facts) sidecar[intent.intentId] = facts;
          return projected;
        });
        if (mutations.length > 0) result.set(schema.scope_index, mutations);
      })
    );
    return { byScope: result, sidecar };
  }

  /** Cacheable: shape metadata, stable until a scope is revoked. */
  private async contentHashed(
    appId: string,
    purpose: string,
    entity: string
  ): Promise<boolean> {
    const key = `${appId}\u0000${purpose}\u0000${entity}`;
    const cached = this.#contentHashed.get(key);
    if (cached !== undefined) return cached;
    // Every scope revoked: there is no union to build, and the read itself
    // reports the empty plane. Do not turn that into a SQL syntax error here.
    if (this.#scopes.length === 0) return false;
    const parameters: ReplicaBindValue[] = [];
    const union = this.#scopes
      .map((scope) => {
        parameters.push(appId, purpose, entity);
        return `SELECT es.shape_id, es.primary_key, es.columns_json,
                       es.has_unavailable_fields
                  FROM ${scope.alias}.replica_entity_schema AS es
                  JOIN ${scope.alias}.replica_shape AS sh
                    ON sh.shape_id = es.shape_id
                 WHERE sh.app_id = ? AND sh.purpose = ? AND es.entity = ?`;
      })
      .join(" UNION ALL ");
    const schemas = await this.query<StoredEntitySchemaRow>(
      `SELECT * FROM (${union})`,
      parameters
    );
    const hashed = schemas.some((row) =>
      parseStringArray(row.columns_json).some((column) =>
        CONTENT_HASH_COLUMNS.includes(column)
      )
    );
    this.#contentHashed.set(key, hashed);
    return hashed;
  }

  /** Prefer op-sqlite's off-thread read; fall back to the shared sync contract. */
  private query<T extends object>(
    sql: string,
    parameters: readonly ReplicaBindValue[]
  ): Promise<T[]> {
    const asyncAll = (this.#driver as AsyncReadDriver).allAsync;
    if (asyncAll)
      return asyncAll.call(this.#driver, sql, parameters) as Promise<T[]>;
    return Promise.resolve(this.#driver.all<T>(sql, parameters));
  }

  private storePlacement(record: PlacementRecord): void {
    this.#driver.run(
      `INSERT INTO native_placement_outbox
         (link_token, status, target_vault_id, record_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(link_token) DO UPDATE SET
         status = excluded.status,
         target_vault_id = excluded.target_vault_id,
         record_json = excluded.record_json,
         updated_at = excluded.updated_at`,
      [
        record.linkToken,
        record.status,
        record.targetVaultId,
        JSON.stringify(record),
        record.updatedAt,
      ]
    );
  }

  private aggregateState(): {
    cursor: ReplicaCursor;
    coverage: "partial" | "complete";
  } {
    const states = this.sourceStates();
    if (states.length === 0)
      return { cursor: { epoch: "mounted", seq: 0 }, coverage: "partial" };
    return {
      cursor: {
        epoch: "mounted",
        seq: Math.min(...states.map((state) => state.cursor_seq)),
      },
      coverage: states.every((state) => state.coverage === "complete")
        ? "complete"
        : "partial",
    };
  }

  private sourceStates(): ReplicaSourceState[] {
    if (this.#scopes.length === 0) return [];
    return this.#scopes.map(
      (scope) =>
        this.#driver.all<ReplicaSourceState>(cursorSql(scope))[0] ?? {
          cursor_epoch: "uninitialized",
          cursor_seq: 0,
          coverage: "partial",
        }
    );
  }
}

/** Can this pending mutation remove a canonical hit from a composed page? */
function displaces(
  mutation: OptimisticMutation,
  indexed: ReadonlySet<string>
): boolean {
  return (
    mutation.op === "delete" ||
    Object.keys(mutation.values).some((column) => indexed.has(column))
  );
}

/**
 * One schema for a read spanning several vaults. Where the mounted databases
 * disagree, take the answer that REFUSES more, never less: any vault's column
 * is nameable, and one vault withholding fields makes the whole read check
 * availability per row. The primary key is the first vault's — the key the
 * merged read breaks order ties on.
 */
function mergedSchema(
  entity: string,
  schemas: readonly ScopedEntitySchemaRow[]
): ReplicaEntitySchema {
  const columns = new Set<string>();
  for (const schema of schemas)
    for (const column of parseStringArray(schema.columns_json))
      columns.add(column);
  return {
    entity,
    primaryKey: schemas[0]!.primary_key,
    columns: [...columns],
    hasUnavailableFields: schemas.some(
      (schema) => schema.has_unavailable_fields === 1
    ),
  };
}

function withoutPlacementState(record: PlacementRecord): PlacementIntent {
  return {
    linkToken: record.linkToken,
    kind: record.kind,
    itemType: record.itemType,
    itemId: record.itemId,
    sourceVaultId: record.sourceVaultId,
    targetVaultId: record.targetVaultId,
  };
}

function cursorSql(scope: AttachedScope): string {
  return `SELECT cursor_epoch, cursor_seq, 'complete' AS coverage
            FROM ${scope.alias}.replica_meta
          UNION ALL
          SELECT cursor_epoch, cursor_seq, 'partial' AS coverage
            FROM ${scope.alias}.replica_bootstrap_progress
           WHERE cursor_epoch IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${scope.alias}.replica_meta)`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
