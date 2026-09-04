/**
 * THE GOLDEN PHONE REPLICA (#927 P4).
 *
 * The vault half of the golden artifact is `year3-vault.ts`. This is the other
 * half: the SQLite file a phone holds after a FULL bootstrap of that vault,
 * plus the outbox of pending intents the converge journey needs (N ∈ 1, 10,
 * 40 — the three volumes #927's journey table names).
 *
 * NEVER A HAND-BUILT REPLICA. Every row here arrives through the real
 * bootstrap path — `packages/vault/src/replica/snapshot.ts#readReplicaRows`
 * produces the pages, `packages/client/src/replica/store-core.ts`'s
 * `ReplicaSqliteStore.bootstrap` applies them, and the outbox is written
 * through the phone's own `SqliteIntentStore`. A fixture that hand-writes
 * `replica_row` would agree with itself and with nothing else: it would
 * survive a change to the apply path that breaks every phone.
 *
 * `@centraid/test-kit` deliberately does not depend on `@centraid/vault` or
 * `@centraid/client` (see `year3FixtureCacheKey`), so those three seams are
 * INJECTED. `tests/helpers/factories.ts` wires the real ones; the kit's own
 * suite wires them too, which is what keeps the shapes below honest.
 */
import { createHash } from "node:crypto";

import { seededRandom } from "./random.js";
import type { Year3Distributions } from "./year3-vault.js";

export const YEAR3_REPLICA_PROTOCOL_VERSION = 1 as const;
export const YEAR3_REPLICA_APP_ID = "_golden";
export const YEAR3_REPLICA_SHAPE_ID = "golden-year3";

/** The converge journey's three volumes (#927, journey table). */
export const YEAR3_PENDING_INTENT_VOLUMES = [1, 10, 40] as const;
export type Year3PendingIntentVolume =
  (typeof YEAR3_PENDING_INTENT_VOLUMES)[number];

/**
 * Entities the golden replica mirrors, in walk order. These are the logical
 * names of the daily-use path the journeys drive: the people a screen shows,
 * the photos it renders, the notes it searches, and the content items both
 * hang their bytes off. Order is part of the artifact — it decides which rows
 * a capped walk keeps.
 */
export const YEAR3_REPLICA_ENTITIES = [
  "core.party",
  "media.asset",
  "core.content_item",
  "knowledge.note",
  "schedule.task",
] as const;

export interface Year3ReplicaSourceRow {
  readonly rowId: string;
  readonly values: Record<string, unknown>;
  readonly rowVersion?: number;
  /** Oversized or binary values the gateway defers rather than ships. */
  readonly deferredColumns: readonly string[];
}

export interface Year3ReplicaSourcePage {
  readonly entity: string;
  readonly columns: readonly string[];
  readonly sealedColumns: readonly string[];
  readonly rows: readonly Year3ReplicaSourceRow[];
  readonly nextAfter?: string;
  readonly hasMore: boolean;
}

/** The vault side of the bootstrap, bound to one open golden vault. */
export interface Year3ReplicaSource {
  readonly vaultId: string;
  readonly schemaEpoch: string;
  readonly cursor: { readonly epoch: string; readonly seq: number };
  /** `readReplicaRows`, bound to the golden vault's handle. */
  readonly readRows: (
    entity: string,
    options: { after?: string; limit: number }
  ) => Year3ReplicaSourcePage;
  /** The entity's single primary-key column, from the vault's own table info. */
  readonly primaryKeyOf: (entity: string) => string;
}

export interface Year3ReplicaEntitySchema {
  entity: string;
  primaryKey: string;
  columns: string[];
  hasUnavailableFields?: boolean;
}

export interface Year3ReplicaSnapshotRow {
  shapeId: string;
  entity: string;
  rowId: string;
  values: Record<string, unknown>;
  rowVersion?: number;
  oversizedFields?: string[];
}

/** Structurally the client's `ReplicaSnapshot`; typed here so the kit stays
 *  free of a `@centraid/client` dependency. */
export interface Year3ReplicaSnapshot {
  protocolVersion: typeof YEAR3_REPLICA_PROTOCOL_VERSION;
  vaultId: string;
  schemaEpoch: string;
  shapes: {
    shapeId: string;
    appId: string;
    purpose: string;
    entities: Year3ReplicaEntitySchema[];
  }[];
  cursor: { epoch: string; seq: number };
  rows: Year3ReplicaSnapshotRow[];
}

export interface Year3ReplicaSnapshotOptions {
  /** Defaults to {@link YEAR3_REPLICA_ENTITIES}. */
  readonly entities?: readonly string[];
  /**
   * Hard ceiling on mirrored rows — the declared year-3 phone volume
   * (`Year3Distributions.replicaRows`). A walk that exhausts the source before
   * the ceiling stops there: a bootstrap holds what the vault has.
   */
  readonly maxRows: number;
  /** Page size of the walk. The gateway's own bootstrap window is 5,000. */
  readonly pageLimit?: number;
}

/**
 * Walk the golden vault through the vault's own replica reader and assemble
 * the bootstrap snapshot a phone receives.
 *
 * The shape catalog is derived from what the READER answers, never from a
 * hand-written column list: `readReplicaRows` already removes the columns a
 * replica may not hold, so the catalog is the vault's own answer to "what does
 * a replica see", and a schema change reaches the fixture without an edit
 * here.
 */
export function buildYear3ReplicaSnapshot(
  source: Year3ReplicaSource,
  options: Year3ReplicaSnapshotOptions
): Year3ReplicaSnapshot {
  const entities = options.entities ?? YEAR3_REPLICA_ENTITIES;
  const pageLimit = options.pageLimit ?? 5_000;
  const schemas: Year3ReplicaEntitySchema[] = [];
  const rows: Year3ReplicaSnapshotRow[] = [];
  for (const entity of entities) {
    if (rows.length >= options.maxRows) break;
    const primaryKey = source.primaryKeyOf(entity);
    let after: string | undefined;
    let schema: Year3ReplicaEntitySchema | undefined;
    for (;;) {
      const page = source.readRows(entity, {
        ...(after === undefined ? {} : { after }),
        limit: Math.min(pageLimit, options.maxRows - rows.length),
      });
      schema ??= {
        entity,
        primaryKey,
        columns: [...page.columns],
        ...(page.sealedColumns.length > 0
          ? { hasUnavailableFields: true }
          : {}),
      };
      for (const row of page.rows) {
        rows.push({
          shapeId: YEAR3_REPLICA_SHAPE_ID,
          entity,
          rowId: row.rowId,
          values: { ...row.values },
          ...(row.rowVersion === undefined
            ? {}
            : { rowVersion: row.rowVersion }),
          ...(row.deferredColumns.length > 0
            ? { oversizedFields: [...row.deferredColumns] }
            : {}),
        });
      }
      if (!page.hasMore || page.nextAfter === undefined) break;
      if (rows.length >= options.maxRows) break;
      after = page.nextAfter;
    }
    if (schema) schemas.push(schema);
  }
  return {
    protocolVersion: YEAR3_REPLICA_PROTOCOL_VERSION,
    vaultId: source.vaultId,
    schemaEpoch: source.schemaEpoch,
    shapes: [
      {
        shapeId: YEAR3_REPLICA_SHAPE_ID,
        appId: YEAR3_REPLICA_APP_ID,
        purpose: YEAR3_REPLICA_PURPOSE,
        entities: schemas,
      },
    ],
    cursor: { epoch: source.cursor.epoch, seq: source.cursor.seq },
    rows,
  };
}

export interface Year3PendingIntent {
  intentId: string;
  payloadHash: string;
  appId: string;
  action: string;
  input: Record<string, unknown>;
  state: "queued";
  attempts: 0;
  enqueuedAt: string;
  optimistic: never[];
}

/**
 * The outbox a phone holds when the network returns: N intents queued, never
 * sent, in the order they were made. Deterministic in the fixture seed, so the
 * same N always produces the same N rows.
 *
 * `hashPayload` is the phone's OWN canonical hash
 * (`packages/client/src/replica/payload-hash.ts`) — the daemon verifies an
 * intent id against it, so a fixture that invented its own digest would queue
 * intents no gateway would accept.
 */
export async function year3PendingIntents(
  count: number,
  hashPayload: (intent: {
    appId: string;
    action: string;
    input: Record<string, unknown>;
  }) => Promise<string>,
  seed: number
): Promise<Year3PendingIntent[]> {
  const random = seededRandom(seed);
  const intents: Year3PendingIntent[] = [];
  for (let index = 0; index < count; index += 1) {
    const input = {
      noteId: `year3-note-${String(random.int(0, 999)).padStart(6, "0")}`,
      title: `Edited offline ${index}`,
    };
    const payload = {
      appId: "notes",
      action: "notes.rename_note",
      input,
    };
    intents.push({
      intentId: `year3-intent-${String(index).padStart(4, "0")}`,
      // Sequential by construction: the hash is the payload's, and the loop
      // draws its next payload from the same seeded stream.
      // oxlint-disable-next-line no-await-in-loop
      payloadHash: await hashPayload(payload),
      appId: payload.appId,
      action: payload.action,
      input,
      state: "queued",
      attempts: 0,
      // Inside the fixture's own 2023–2025 window, one minute apart.
      enqueuedAt: new Date(
        Date.parse("2025-12-31T00:00:00.000Z") + index * 60_000
      ).toISOString(),
      optimistic: [],
    });
  }
  return intents;
}

/**
 * Content address of one golden replica. Distinct from the vault's key by the
 * pending-intent count and the mirrored entity list: two replicas built from
 * the same vault with different outboxes are different artifacts.
 */
export function year3ReplicaCacheKey(
  vaultKey: string,
  pendingIntents: number,
  entities: readonly string[] = YEAR3_REPLICA_ENTITIES
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ vaultKey, pendingIntents, entities: [...entities] })
    )
    .digest("hex");
}

/** Declared distributions the replica half consumes. */
export function year3ReplicaRowCeiling(
  distributions: Year3Distributions
): number {
  return distributions.replicaRows;
}
