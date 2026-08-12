// governance: allow-repo-hygiene file-size-limit (#738) the mounted-reader transaction boundary keeps attach, schema, overlay, FTS, provenance, and cursor composition in one audited class
import {
  applyOptimisticMutations,
  DEFAULT_REPLICA_PURPOSE,
  evaluateReplicaRead,
  OnlineOnlyError,
  presentPendingIntentMutation,
  replicaFtsMatchExpression,
  replicaPendingSearchMatch,
  replicaPendingSearchRank,
  replicaSearchRequiredColumns,
  replicaLocalSearchSpec,
  ReplicaProtocolError,
} from "@centraid/client/replica/native";
import type {
  OptimisticMutation,
  ReplicaBindValue,
  ReplicaCursor,
  ReplicaIntent,
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
  ReplicaSqliteDriver,
} from "@centraid/client/replica/native";

import {
  dedupeReplicaRowsByContent,
  parseStringArray,
  replicaScopeEnvelope,
  storedReplicaEnvelope,
  storedSchema,
} from "./multi-vault-provenance";
import type { StoredReplicaRow } from "./multi-vault-provenance";
import type { NativeReadRequest, NativeSearchRequest } from "./native-session";
import { MAX_MOUNTED_NATIVE_SCOPES } from "./offline-budgets";
import { planReplicaRead } from "./replica-read-pushdown";
import type { ReplicaReadPlan } from "./replica-read-pushdown";

/**
 * Column names `dedupeReplicaRowsByContent` collapses rows on. An entity that
 * exposes one can merge rows across scopes, which is what makes a per-scope
 * `LIMIT` unsafe: the duplicate that supplies a source badge may sit outside the
 * other scope's page.
 */
const CONTENT_HASH_COLUMNS = ["sha256", "content_sha256", "blob_sha256"];

/**
 * The off-thread read op-sqlite offers on top of the shared driver contract.
 * `ReplicaSqliteDriver` lives in `@centraid/client` and is deliberately
 * synchronous (the web engine drives it from inside a worker). On the phone the
 * driver runs on the JS thread, so a 50k-row scan freezes the UI; the native
 * driver adds this and the reader prefers it when present.
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
  /** Whether this is the member's OWN vault — the founding marker, straight
   *  from the vault record (issue #711 item H). Undefined only for a scope
   *  mounted before the gateway answered, which reads as their own. */
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
    | "media.media_asset"
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

interface ScopedStoredRow extends StoredReplicaRow {
  scope_index: number;
}

interface ScopedSearchRow extends SearchRow {
  scope_index: number;
}

interface AttachedScope extends MountedReplicaScope {
  alias: string;
}

const OVERLAY_STATES = new Set([
  "queued",
  "sending",
  "awaiting-change",
  "parked",
  "denied",
  "conflict",
  "failed",
]);

/**
 * One op-sqlite connection with every mounted vault attached.
 *
 * Per-vault sessions remain the only writers. Reads and FTS fan-in happen on
 * this connection so changing the visible Vault is a filter change, not a
 * session teardown. Every row carries vault provenance and row-level write
 * authority; equal content hashes collapse into one row with several badges.
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

  async read(
    appId: string,
    request: NativeReadRequest
  ): Promise<ReplicaReadWireResult> {
    const purpose = request.purpose ?? DEFAULT_REPLICA_PURPOSE;
    const schemas = await this.schemasForAll(appId, purpose, request.entity);
    const overlays = await this.overlaysForAll(appId, request.entity, schemas);
    const planned = planReplicaRead({
      request,
      contentHashed: await this.contentHashed(appId, purpose, request.entity),
      scopeCount: this.#scopes.length,
    });
    // SQL pushdown sees only canonical payload_json. A projection can change a
    // filtered column, so compose the normal bounded hits with exactly the
    // canonical row ids addressed by the outbox. Work scales with the page and
    // pending mutations, never with the vault merely because one write exists.
    const [canonicalPage, addressed] = await Promise.all([
      this.rowsForAll(appId, purpose, request.entity, planned),
      this.rowsForOverlayTargets(request.entity, schemas, overlays),
    ]);
    const scoped = mergeScopedRows(canonicalPage, addressed);
    const result = this.evaluate(
      appId,
      purpose,
      request,
      scoped,
      schemas,
      overlays
    );
    const limit = planned.perScopeLimit;
    if (limit === undefined || result.rows.length >= limit) return result;
    // A short page only proves there is no more data when nothing was cut off.
    // Dedupe collapses rows, so a saturated scope page can hide rows the
    // unlimited read would have surfaced: pay for the full scan exactly then.
    const saturated = this.#scopes.some(
      (_scope, index) =>
        canonicalPage.filter((row) => row.scope_index === index).length ===
        limit
    );
    if (!saturated) return result;
    return this.evaluate(
      appId,
      purpose,
      request,
      mergeScopedRows(
        await this.rowsForAll(appId, purpose, request.entity, {
          ...planned,
          perScopeLimit: undefined,
        }),
        addressed
      ),
      schemas,
      overlays
    );
  }

  private evaluate(
    appId: string,
    purpose: string,
    request: NativeReadRequest,
    scoped: readonly ScopedStoredRow[],
    schemas: readonly ScopedEntitySchemaRow[],
    overlays: ReadonlyMap<number, OptimisticMutation[]>
  ): ReplicaReadWireResult {
    if (schemas.length === 0) {
      const aggregate = this.aggregateState();
      return {
        rows: [],
        cursor: aggregate.cursor,
        dependency: {
          shapeId: request.shapeId ?? `${appId}:${purpose}`,
          entity: request.entity,
        },
        coverage: aggregate.coverage,
      };
    }
    const schema = storedSchema(request.entity, schemas[0]!);
    const byScope: ReplicaRowEnvelope[] = [];
    for (const scopedSchema of schemas) {
      const scope = this.#scopes[scopedSchema.scope_index]!;
      const localSchema = storedSchema(request.entity, scopedSchema);
      const canonical = scoped
        .filter((row) => row.scope_index === scopedSchema.scope_index)
        // Compose before provenance prefixes the envelope identity. Intent row
        // ids and canonical primary keys deliberately share this domain.
        .map((row) => storedReplicaEnvelope(row));
      byScope.push(
        ...applyOptimisticMutations(
          canonical,
          overlays.get(scopedSchema.scope_index) ?? [],
          localSchema
        ).map((row) => replicaScopeEnvelope(scope, row))
      );
    }
    const rows = dedupeReplicaRowsByContent(byScope);
    const evaluated = evaluateReplicaRead(
      rows,
      schema,
      {
        ...request,
        shapeId: request.shapeId ?? schemas[0]!.shape_id,
      },
      []
    );
    const aggregate = this.aggregateState();
    return {
      rows: evaluated,
      cursor: aggregate.cursor,
      dependency: {
        shapeId: request.shapeId ?? schemas[0]!.shape_id,
        entity: request.entity,
      },
      coverage: aggregate.coverage,
    };
  }

  /**
   * Federated FTS5: execute the same bounded MATCH against every attached
   * index, then rank and dedupe the combined hits on the single read plane.
   */
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
    const limit = Math.min(Math.max(request.limit ?? 100, 1), 1_000);
    const overlayCount = [...overlays.values()].reduce(
      (count, mutations) => count + mutations.length,
      0
    );
    const fetchLimit = limit + overlayCount;
    if (fetchLimit > 10_000)
      throw new OnlineOnlyError(
        "the pending federated search overlay exceeds the local bounded work limit"
      );
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
      const mutations = overlays.get(schema.scope_index) ?? [];
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
          .flatMap((row, index) => {
            if (!indexedRowIds.has(row.rowId))
              return hitIds.has(row.rowId) ? [row] : [];
            const local = replicaPendingSearchMatch(
              row.values,
              searchSpec,
              request.query
            );
            if (!local.matches) return [];
            return [
              {
                ...row,
                values: {
                  ...row.values,
                  _rank: replicaPendingSearchRank(
                    schema.scope_index * fetchLimit + index
                  ),
                  _snippet: local.snippet,
                },
              },
            ];
          })
          .map((row) => replicaScopeEnvelope(scope, row))
      );
    }
    const rows = dedupeReplicaRowsByContent(hits)
      .sort(
        (left, right) =>
          Number(left.values._rank ?? 0) - Number(right.values._rank ?? 0)
      )
      .slice(0, limit);
    const aggregate = this.aggregateState();
    return {
      rows,
      cursor: aggregate.cursor,
      dependency: {
        shapeId: request.shapeId ?? `${appId}:${purpose}`,
        entity: request.entity,
      },
      coverage: aggregate.coverage,
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

  private rowsForAll(
    appId: string,
    purpose: string,
    entity: string,
    plan: ReplicaReadPlan
  ): Promise<ScopedStoredRow[]> {
    if (this.#scopes.length === 0) return Promise.resolve([]);
    const parameters: ReplicaBindValue[] = [];
    const union = this.#scopes
      .map((scope, scopeIndex) => {
        parameters.push(appId, purpose, entity, ...plan.filterParams);
        const select = `SELECT ${scopeIndex} AS scope_index,
                       r.shape_id, r.row_id, r.payload_json, r.oversized_json,
                       r.server_version,
                       es.primary_key, es.columns_json,
                       es.has_unavailable_fields, m.cursor_epoch, m.cursor_seq,
                       m.coverage
                  FROM ${scope.alias}.replica_row AS r
                  JOIN ${scope.alias}.replica_entity_schema AS es
                    ON es.shape_id = r.shape_id AND es.entity = r.entity
                  JOIN ${scope.alias}.replica_shape AS sh
                    ON sh.shape_id = r.shape_id
                  JOIN (${cursorSql(scope)}) AS m
                 WHERE sh.app_id = ? AND sh.purpose = ? AND r.entity = ?${plan.filterSql}`;
        if (plan.perScopeLimit === undefined) return select;
        parameters.push(plan.perScopeLimit);
        // A compound arm cannot carry its own LIMIT; wrapping each one keeps
        // the page per source rather than across the union.
        return `SELECT * FROM (${select} LIMIT ?)`;
      })
      .join(" UNION ALL ");
    return this.query<ScopedStoredRow>(`SELECT * FROM (${union})`, parameters);
  }

  /** Fetch canonical bases for only rows an optimistic mutation addresses. */
  private async rowsForOverlayTargets(
    entity: string,
    schemas: readonly ScopedEntitySchemaRow[],
    overlays: ReadonlyMap<number, OptimisticMutation[]>
  ): Promise<ScopedStoredRow[]> {
    const batches = schemas.flatMap((schema) => {
      const rowIds = [
        ...new Set(
          (overlays.get(schema.scope_index) ?? [])
            .filter((mutation) => mutation.shapeId === schema.shape_id)
            .map((mutation) => mutation.rowId)
        ),
      ];
      const scope = this.#scopes[schema.scope_index]!;
      return Array.from(
        { length: Math.ceil(rowIds.length / 400) },
        (_, index) => rowIds.slice(index * 400, (index + 1) * 400)
      ).map((chunk) =>
        this.query<ScopedStoredRow>(
          `SELECT ${schema.scope_index} AS scope_index,
                  r.shape_id, r.row_id, r.payload_json, r.oversized_json,
                  r.server_version,
                  es.primary_key, es.columns_json,
                  es.has_unavailable_fields, m.cursor_epoch, m.cursor_seq,
                  m.coverage
             FROM ${scope.alias}.replica_row AS r
             JOIN ${scope.alias}.replica_entity_schema AS es
               ON es.shape_id = r.shape_id AND es.entity = r.entity
             JOIN (${cursorSql(scope)}) AS m
            WHERE r.shape_id = ? AND r.entity = ?
              AND r.row_id IN (${chunk.map(() => "?").join(", ")})`,
          [schema.shape_id, entity, ...chunk]
        )
      );
    });
    return (await Promise.all(batches)).flat();
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
  ): Promise<Map<number, OptimisticMutation[]>> {
    const result = new Map<number, OptimisticMutation[]>();
    await Promise.all(
      schemas.map(async (schema) => {
        const scope = this.#scopes[schema.scope_index]!;
        const table = await this.query<{ present: number }>(
          `SELECT 1 AS present FROM ${scope.alias}.sqlite_master
            WHERE type = 'table' AND name = 'replica_intent_outbox' LIMIT 1`,
          []
        );
        if (!table[0]) return;
        const records = await this.query<StoredIntentRow>(
          `SELECT record_json FROM ${scope.alias}.replica_intent_outbox
            ORDER BY created_order`,
          []
        );
        const mutations = records.flatMap((row) => {
          const intent = JSON.parse(row.record_json) as ReplicaIntent;
          if (!OVERLAY_STATES.has(intent.state) || intent.appId !== appId)
            return [];
          return intent.optimistic
            .filter(
              (mutation) =>
                mutation.entity === entity &&
                mutation.shapeId === schema.shape_id
            )
            .map((mutation) => presentPendingIntentMutation(mutation, intent));
        });
        if (mutations.length > 0) result.set(schema.scope_index, mutations);
      })
    );
    return result;
  }

  /**
   * Does this entity expose a content hash? Only then can dedupe merge rows
   * from different scopes, which is what makes a per-scope page unsafe. Cached
   * because it is shape metadata: one row, stable until a scope is revoked.
   */
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

function mergeScopedRows(
  canonical: readonly ScopedStoredRow[],
  addressed: readonly ScopedStoredRow[]
): ScopedStoredRow[] {
  const merged = [...canonical];
  const seen = new Set(
    canonical.map(
      (row) => `${row.scope_index}\u0000${row.shape_id}\u0000${row.row_id}`
    )
  );
  for (const row of addressed) {
    const key = `${row.scope_index}\u0000${row.shape_id}\u0000${row.row_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
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
