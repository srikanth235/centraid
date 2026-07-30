import {
  DEFAULT_REPLICA_PURPOSE,
  evaluateReplicaRead,
  replicaFtsMatchExpression,
  replicaSearchRequiredColumns,
  replicaLocalSearchSpec,
  ReplicaProtocolError,
} from "@centraid/client/replica/native";
import type {
  ReplicaBindValue,
  ReplicaCursor,
  ReplicaReadWireResult,
  ReplicaSearchWireResult,
  ReplicaSqliteDriver,
} from "@centraid/client/replica/native";

import {
  dedupeReplicaRowsByContent,
  parseStringArray,
  replicaEnvelope,
  storedSchema,
} from "./multi-vault-provenance";
import type { StoredReplicaRow } from "./multi-vault-provenance";
import type { NativeReadRequest, NativeSearchRequest } from "./native-session";
import { MAX_MOUNTED_NATIVE_SCOPES } from "./offline-budgets";

export interface MountedReplicaScope {
  vaultId: string;
  label: string;
  role: "admin" | "write" | "read";
  databaseName: string;
}

export interface PlacementIntent {
  linkToken: string;
  kind: "add" | "move";
  itemType:
    | "core.collection"
    | "core.document"
    | "core.content_item"
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

/**
 * One op-sqlite connection with every mounted vault attached.
 *
 * Per-vault sessions remain the only writers. Reads and FTS fan-in happen on
 * this connection so changing the visible Space is a filter change, not a
 * session teardown. Every row carries vault provenance and row-level write
 * authority; equal content hashes collapse into one row with several badges.
 */
export class MultiVaultReplicaReader {
  readonly #driver: ReplicaSqliteDriver;
  readonly #scopes: AttachedScope[];

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

  read(appId: string, request: NativeReadRequest): ReplicaReadWireResult {
    const purpose = request.purpose ?? DEFAULT_REPLICA_PURPOSE;
    const byScope = this.rowsForAll(appId, purpose, request.entity).map(
      (row) => ({
        scope: this.#scopes[row.scope_index]!,
        row,
      })
    );
    if (byScope.length === 0) {
      return {
        rows: [],
        cursor: this.aggregateCursor([]),
        dependency: {
          shapeId: request.shapeId ?? `${appId}:${purpose}`,
          entity: request.entity,
        },
      };
    }
    const schema = storedSchema(request.entity, byScope[0]!.row);
    const rows = dedupeReplicaRowsByContent(
      byScope.map(({ scope, row }) => replicaEnvelope(scope, row))
    );
    const evaluated = evaluateReplicaRead(
      rows,
      schema,
      {
        ...request,
        shapeId: request.shapeId ?? byScope[0]!.row.shape_id,
      },
      []
    );
    return {
      rows: evaluated,
      cursor: this.aggregateCursor(byScope.map(({ row }) => row)),
      dependency: {
        shapeId: request.shapeId ?? byScope[0]!.row.shape_id,
        entity: request.entity,
      },
    };
  }

  /**
   * Federated FTS5: execute the same bounded MATCH against every attached
   * index, then rank and dedupe the combined hits on the single read plane.
   */
  search(appId: string, request: NativeSearchRequest): ReplicaSearchWireResult {
    const purpose = request.purpose ?? DEFAULT_REPLICA_PURPOSE;
    if ((request.where?.length ?? 0) > 0) {
      throw new ReplicaProtocolError(
        "Federated replica search does not accept filters"
      );
    }
    const required = replicaSearchRequiredColumns(
      replicaLocalSearchSpec(request.entity)
    );
    const limit = Math.min(Math.max(request.limit ?? 100, 1), 1_000);
    const match = replicaFtsMatchExpression(request.query);
    const parameters: ReplicaBindValue[] = [];
    const union = this.#scopes
      .map((scope, scopeIndex) => {
        parameters.push(match, limit, appId, purpose, request.entity);
        return `SELECT ${scopeIndex} AS scope_index,
                       s.shape_id, s.row_id, r.payload_json, r.oversized_json,
                       es.primary_key, es.columns_json,
                       es.has_unavailable_fields, m.cursor_epoch,
                       m.cursor_seq, s.rank AS rank, s.snippet
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
    parameters.push(limit);
    const combined = this.#driver.all<ScopedSearchRow>(
      `SELECT * FROM (${union}) ORDER BY rank LIMIT ?`,
      parameters
    );
    const hits = combined.flatMap((row) => {
      const scope = this.#scopes[row.scope_index]!;
      const columns = parseStringArray(row.columns_json);
      if (required.some((column) => !columns.includes(column))) return [];
      return [
        {
          scope,
          row,
          envelope: replicaEnvelope(scope, row, {
            _rank: row.rank,
            _snippet: row.snippet ?? "",
          }),
        },
      ];
    });
    const rows = dedupeReplicaRowsByContent(hits.map((hit) => hit.envelope))
      .sort(
        (left, right) =>
          Number(left.values._rank ?? 0) - Number(right.values._rank ?? 0)
      )
      .slice(0, limit);
    return {
      rows,
      cursor: this.aggregateCursor(hits.map(({ row }) => row)),
      dependency: {
        shapeId: request.shapeId ?? `${appId}:${purpose}`,
        entity: request.entity,
      },
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
    entity: string
  ): ScopedStoredRow[] {
    const parameters: ReplicaBindValue[] = [];
    const union = this.#scopes
      .map((scope, scopeIndex) => {
        parameters.push(appId, purpose, entity);
        return `SELECT ${scopeIndex} AS scope_index,
                       r.shape_id, r.row_id, r.payload_json, r.oversized_json,
                       es.primary_key, es.columns_json,
                       es.has_unavailable_fields, m.cursor_epoch, m.cursor_seq
                  FROM ${scope.alias}.replica_row AS r
                  JOIN ${scope.alias}.replica_entity_schema AS es
                    ON es.shape_id = r.shape_id AND es.entity = r.entity
                  JOIN ${scope.alias}.replica_shape AS sh
                    ON sh.shape_id = r.shape_id
                  JOIN (${cursorSql(scope)}) AS m
                 WHERE sh.app_id = ? AND sh.purpose = ? AND r.entity = ?`;
      })
      .join(" UNION ALL ");
    return this.#driver.all<ScopedStoredRow>(
      `SELECT * FROM (${union})`,
      parameters
    );
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

  private aggregateCursor(rows: readonly StoredReplicaRow[]): ReplicaCursor {
    if (rows.length === 0) return { epoch: "mounted", seq: 0 };
    return {
      epoch: "mounted",
      seq: Math.min(...rows.map((row) => row.cursor_seq)),
    };
  }
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
  return `SELECT cursor_epoch, cursor_seq FROM ${scope.alias}.replica_meta
          UNION ALL
          SELECT cursor_epoch, cursor_seq
            FROM ${scope.alias}.replica_bootstrap_progress
           WHERE cursor_epoch IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${scope.alias}.replica_meta)`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
