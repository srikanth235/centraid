// governance: allow-repo-hygiene file-size-limit (#738) one cohesive mounted-reader fixture covers provenance, restart durability, revocation, FTS, and the measured 50k-row budget
import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { encode as encodeJpeg } from "jpeg-js";
import { describe, expect, test, vi } from "vitest";

import { PENDING_OVERLAY_FIELDS } from "@centraid/blueprints/apps/_shared/pending-overlay";
import {
  IntentQueue,
  ReplicaSqliteStore,
} from "@centraid/client/replica/native";
import type {
  IntentState,
  ReplicaBindValue,
} from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "./multi-vault-reader";
import { MultiVaultReplicaSession } from "./multi-vault-session";
import type { NativeChangeFeed } from "./native-session";
import { createNativeReplicaSession } from "./native-session";
import { NodeSqliteDriver } from "./node-sqlite-driver";
import {
  MAX_MOUNTED_NATIVE_SCOPES,
  MOBILE_REPLICA_BOOTSTRAP_WINDOW,
  THUMBNAIL_SOURCE_BUDGET_BYTES,
} from "./offline-budgets";
import { SqliteIntentStore } from "./sqlite-intent-store";

const SHAPES = [
  {
    shapeId: "docs-default",
    appId: "docs",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "core.document",
        primaryKey: "document_id",
        columns: [
          "document_id",
          "title",
          "current_content_id",
          "created_at",
          "updated_at",
          "deleted_at",
        ],
      },
      {
        entity: "core.content_item",
        primaryKey: "content_id",
        columns: [
          "content_id",
          "title",
          "sha256",
          "media_type",
          "byte_size",
          "created_at",
          "deleted_at",
        ],
      },
    ],
  },
] as const;

const JOURNEY_SHAPES = [
  {
    shapeId: "tasks-default",
    appId: "tasks",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "schedule.task",
        primaryKey: "task_id",
        columns: [
          "task_id",
          "title",
          "description",
          "status",
          "project_id",
          "completed_at",
          "deleted_at",
        ],
      },
      {
        entity: "schedule.project",
        primaryKey: "project_id",
        columns: [
          "project_id",
          "name",
          "area",
          "color",
          "sort_order",
          "archived_at",
        ],
      },
    ],
  },
  {
    shapeId: "tally-default",
    appId: "tally",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "tally.expense",
        primaryKey: "expense_id",
        columns: [
          "expense_id",
          "group_id",
          "description",
          "amount_minor",
          "original_amount_minor",
          "original_currency",
          "settlement_currency",
          "rate_scaled",
          "rate_scale",
          "rate_source",
          "rate_date",
          "paid_by",
          "category",
          "spent_on",
          "deleted_at",
        ],
      },
      {
        entity: "tally.expense_split",
        primaryKey: "__centraid_row_id",
        columns: ["__centraid_row_id", "expense_id", "party_id", "share_minor"],
      },
      // Several payers is the ordinary shape now, so the offline expense
      // projects payer rows too (`apps/tally/pending-projection.ts`). Without
      // this entity in the shape the optimistic write has nowhere to land and
      // the queued expense reads as unpaid after a restart.
      {
        entity: "tally.expense_payer",
        primaryKey: "__centraid_row_id",
        columns: ["__centraid_row_id", "expense_id", "party_id", "paid_minor"],
      },
    ],
  },
  {
    shapeId: "agenda-default",
    appId: "agenda",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "core.event",
        primaryKey: "event_id",
        columns: ["event_id", "summary", "dtstart", "dtend", "status"],
      },
    ],
  },
  {
    shapeId: "notes-default",
    appId: "notes",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "knowledge.note",
        primaryKey: "note_id",
        columns: [
          "note_id",
          "body_content_id",
          "title",
          "pinned",
          "notebook_id",
          "deleted_at",
        ],
      },
      {
        entity: "core.content_item",
        primaryKey: "content_id",
        columns: ["content_id", "title", "media_type"],
      },
    ],
  },
] as const;

function seed(file: string, vaultId: string, suffix: string): void {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), vaultId);
  store.bootstrap({
    protocolVersion: 1,
    vaultId,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${suffix}`, seq: 3 },
    shapes: SHAPES.map((shape) => ({
      ...shape,
      entities: shape.entities.map((entity) => ({
        ...entity,
        columns: [...entity.columns],
      })),
    })),
    rows: [
      {
        shapeId: "docs-default",
        entity: "core.content_item",
        rowId: `content-${suffix}`,
        values: {
          content_id: `content-${suffix}`,
          title: "Household plan",
          sha256: "same-bytes",
          media_type: "application/pdf",
          byte_size: 42,
          created_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
        },
      },
      {
        shapeId: "docs-default",
        entity: "core.document",
        rowId: `document-${suffix}`,
        values: {
          document_id: `document-${suffix}`,
          title: "Household plan",
          current_content_id: `content-${suffix}`,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-07-01T00:00:00.000Z",
          deleted_at: null,
        },
      },
    ],
  });
  store.close();
}

function inertFeed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}

async function seedPendingJourney(
  file: string,
  vaultId: string
): Promise<void> {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), vaultId);
  store.bootstrap({
    protocolVersion: 1,
    vaultId,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${vaultId}`, seq: 1 },
    shapes: JOURNEY_SHAPES.map((shape) => ({
      ...shape,
      entities: shape.entities.map((entity) => ({
        ...entity,
        columns: [...entity.columns],
      })),
    })),
    rows: [
      {
        shapeId: "agenda-default",
        entity: "core.event",
        rowId: "event-offline",
        rowVersion: 7,
        values: {
          event_id: "event-offline",
          summary: "Offline planning session",
          dtstart: "2026-08-12T09:00:00.000Z",
          dtend: "2026-08-12T10:00:00.000Z",
          status: "confirmed",
        },
      },
    ],
  });
  store.close();

  let nextId = 0;
  const session = await createNativeReplicaSession({
    gatewayAuth: {
      baseUrl: "http://127.0.0.1:1",
      gatewayId: "offline-gateway",
      vaultId,
    },
    fetcher: () => Promise.reject(new Error("offline journey must not fetch")),
    changeFeed: inertFeed(),
    driver: new NodeSqliteDriver(file),
    isConnected: () => false,
    digest: () => Promise.resolve("digest"),
    idFactory: () => `intent-${++nextId}`,
  });
  await session.write("tasks", {
    action: "save-project",
    input: { name: "Pending project" },
  });
  await session.write("tally", {
    action: "add-expense",
    input: {
      group_id: "group-offline",
      description: "Survives restart expense",
      amount_minor: 1_250,
      original_amount_minor: 1_250,
      original_currency: "USD",
      settlement_currency: "USD",
      rate_scaled: 1_000_000,
      rate_scale: 6,
      rate_source: "identity",
      rate_date: "2026-08-11",
      paid_by: "owner",
      category: "food",
      spent_on: "2026-08-11",
      splits: [{ party_id: "owner", share_minor: 1_250 }],
    },
  });
  await session.write("tasks", {
    action: "add",
    input: {
      project_id: "pending:intent-1:project",
      title: "Survives restart task",
    },
  });
  await session.write("agenda", {
    action: "rsvp",
    input: {
      event_id: "event-offline",
      party_id: "owner",
      partstat: "accepted",
    },
  });
  expect(
    (await session.coordinator.pendingIntents()).find(
      (intent) => intent.appId === "agenda"
    )?.baseVersions
  ).toMatchObject([{ rowId: "event-offline", version: 7 }]);
  await session.write("notes", {
    action: "create-note",
    input: {
      title: "Survives restart note",
      body_text: "Offline body",
      format: "markdown",
    },
  });
  await session.coordinator.applyIntentOutcome({
    intentId: "intent-3",
    status: "failed",
    reason: "Retry after restart",
  });
  await expect(session.retryPendingWrite("intent-3")).resolves.toMatchObject({
    intentId: "intent-6",
    status: "queued",
  });
  await session.close();
}

function seedTenYearLibrary(
  file: string,
  vaultId: string,
  rowCount: number
): void {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), vaultId);
  store.bootstrap({
    protocolVersion: 1,
    vaultId,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${vaultId}`, seq: rowCount },
    shapes: SHAPES.map((shape) => ({
      ...shape,
      entities: shape.entities.map((entity) => ({
        ...entity,
        columns: [...entity.columns],
      })),
    })),
    rows: [],
  });
  store.close();

  // Seed through one prepared native statement per table. Bootstrap's normal
  // per-row validation is covered elsewhere; this fixture is intentionally
  // about the measured ATTACH read/FTS path, not ingest throughput.
  const database = new DatabaseSync(file);
  const insertRow = database.prepare(
    `INSERT INTO replica_row
       (shape_id, entity, row_id, payload_json, oversized_json)
     VALUES ('docs-default', 'core.document', ?, ?, '[]')`
  );
  const insertSearch = database.prepare(
    `INSERT INTO replica_search(shape_id, entity, row_id, body)
     VALUES ('docs-default', 'core.document', ?, ?)`
  );
  database.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < rowCount; index += 1) {
    const year = 2016 + (index % 10);
    const rowId = `${vaultId}-${index}`;
    const title =
      index === rowCount - 1
        ? `Household needle${vaultId}`
        : `Household archive ${index}`;
    insertRow.run(
      rowId,
      JSON.stringify({
        document_id: rowId,
        title,
        current_content_id: null,
        created_at: `${year}-01-01T00:00:00.000Z`,
        updated_at: `${year}-12-31T00:00:00.000Z`,
        deleted_at: null,
      })
    );
    insertSearch.run(rowId, title);
  }
  database.exec("COMMIT");
  database.close();
}

async function seedPendingDocuments(
  file: string,
  vaultId: string,
  count: number
): Promise<void> {
  const driver = new NodeSqliteDriver(file);
  const queue = new IntentQueue(SqliteIntentStore.create(driver), {
    digest: () => Promise.resolve("a".repeat(64)),
  });
  const enqueueNext = async (index: number): Promise<void> => {
    if (index >= count) return;
    const rowId = `pending-${vaultId}-${index}`;
    await queue.enqueue({
      intentId: `intent-${vaultId}-${index}`,
      appId: "docs",
      action: "create-document",
      input: { document_id: rowId, title: `Pending document ${index}` },
      optimistic: [
        {
          op: "upsert",
          shapeId: "docs-default",
          entity: "core.document",
          rowId,
          values: {
            document_id: rowId,
            title: `Pending document ${index}`,
            current_content_id: null,
            created_at: "2026-08-11T00:00:00.000Z",
            updated_at: "2026-08-11T00:00:00.000Z",
            deleted_at: null,
          },
        },
      ],
    });
    return enqueueNext(index + 1);
  };
  await enqueueNext(0);
  queue.close();
  driver.close();
}

/** Minimal payloads: this fixture is about row COUNT, not payload shape. */
function seedBulkDocuments(file: string, vaultId: string, count: number): void {
  seed(file, vaultId, vaultId);
  const database = new DatabaseSync(file);
  const insert = database.prepare(
    `INSERT INTO replica_row
       (shape_id, entity, row_id, payload_json, oversized_json)
     VALUES ('docs-default', 'core.document', ?, ?, '[]')`
  );
  database.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < count; index += 1) {
    const rowId = `bulk-${String(index).padStart(7, "0")}`;
    insert.run(rowId, `{"document_id":"${rowId}"}`);
  }
  database.exec("COMMIT");
  database.close();
}

/** Record what each read asked SQLite for, and how much it got back. */
class RecordingDriver extends NodeSqliteDriver {
  readonly reads: Array<{ sql: string; rows: number }> = [];

  override async allAsync<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): Promise<T[]> {
    const rows = await super.allAsync<T>(sql, bind);
    this.reads.push({ sql, rows: rows.length });
    return rows;
  }
}

/**
 * Fill the durable outbox straight through one prepared statement. `IntentQueue`
 * owns a transaction per intent, which is the right shape for a write and the
 * wrong one for a ten-thousand-row fixture; the DDL still comes from the real
 * store so the table and its `(state, created_order)` index are the shipped ones.
 */
function seedSyntheticOutbox(
  file: string,
  vaultId: string,
  options: {
    count: number;
    appId?: string;
    state?: IntentState;
    startOrder?: number;
  }
): void {
  const driver = new NodeSqliteDriver(file);
  SqliteIntentStore.create(driver);
  driver.close();

  const appId = options.appId ?? "docs";
  const state = options.state ?? "queued";
  const startOrder = options.startOrder ?? 0;
  const database = new DatabaseSync(file);
  const insert = database.prepare(
    `INSERT INTO replica_intent_outbox
       (intent_id, created_order, state, payload_hash, record_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  database.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < options.count; index += 1) {
    const createdOrder = startOrder + index;
    const intentId = `${appId}-${state}-${vaultId}-${index}`;
    const rowId = `pending-${intentId}`;
    insert.run(
      intentId,
      createdOrder,
      state,
      "a".repeat(64),
      JSON.stringify({
        intentId,
        payloadHash: "a".repeat(64),
        appId,
        action: "create-document",
        input: { document_id: rowId },
        state,
        createdOrder,
        attempts: 0,
        optimistic: [
          {
            op: "upsert",
            shapeId: "docs-default",
            entity: "core.document",
            rowId,
            values: {
              document_id: rowId,
              title: `Pending needle ${index}`,
              current_content_id: null,
              created_at: "2026-08-11T00:00:00.000Z",
              updated_at: "2026-08-11T00:00:00.000Z",
              deleted_at: null,
            },
          },
        ],
      })
    );
  }
  database.exec("COMMIT");
  database.close();
}

interface SearchAtScale {
  /** Rows returned, and how many of them the pending writes supplied. */
  returned: number;
  pending: number;
  /** Distinct pending ranks: a large outbox must not collide ordering slots. */
  ranks: number;
  /** The canonical hit is still reachable behind all that pending work. */
  canonical: unknown[];
}

async function searchAtScale(pending: number): Promise<SearchAtScale> {
  const root = tempDirSync(`centraid-search-pending-${pending}-`);
  const personal = path.join(root, "personal.db");
  seed(personal, "personal", "p");
  seedSyntheticOutbox(personal, "personal", { count: pending });
  const reader = new MultiVaultReplicaReader(
    new NodeSqliteDriver(path.join(root, "mounted.db")),
    [
      {
        vaultId: "personal",
        label: "Personal",
        canWrite: true,
        databaseName: personal,
      },
    ]
  );

  try {
    const [needles, canonical] = await Promise.all([
      reader.search("docs", {
        entity: "core.document",
        query: "needle",
        limit: 20,
      }),
      reader.search("docs", {
        entity: "core.document",
        query: "house",
        limit: 20,
      }),
    ]);
    return {
      returned: needles.rows.length,
      pending: needles.rows.filter((row) =>
        String(row.values.title).startsWith("Pending needle")
      ).length,
      ranks: new Set(needles.rows.map((row) => row.values._rank)).size,
      canonical: canonical.rows.map((row) => row.values.document_id),
    };
  } finally {
    reader.close();
  }
}

/**
 * Encode a reproducible sample of the product's 256px/82%-quality thumbnail
 * rung. The smooth gradients plus bounded sensor-like grain exercise JPEG
 * size without checking in private or copyrighted household photos.
 */
function measuredThumbnailBytes(): number[] {
  const edge = 256;
  return Array.from({ length: 12 }, (_, sample) => {
    const pixels = new Uint8Array(edge * edge * 4);
    for (let y = 0; y < edge; y += 1) {
      for (let x = 0; x < edge; x += 1) {
        const offset = (y * edge + x) * 4;
        const grain = ((x * 17 + y * 13 + sample * 23) % 19) - 9;
        pixels[offset] = Math.max(
          0,
          Math.min(255, (x * 3) / 4 + sample * 7 + grain)
        );
        pixels[offset + 1] = Math.max(
          0,
          Math.min(255, (y * 4) / 5 + sample * 5 + grain)
        );
        pixels[offset + 2] = Math.max(
          0,
          Math.min(255, ((x + y) * 3) / 5 + sample * 3 + grain)
        );
        pixels[offset + 3] = 255;
      }
    }
    return encodeJpeg({ data: pixels, width: edge, height: edge }, 82).data
      .length;
  });
}

describe(MultiVaultReplicaReader, () => {
  test("shows native Tally, Tasks, Agenda, and Notes writes from the durable outbox after restart", async () => {
    const root = tempDirSync("centraid-mounted-overlay-");
    const personal = path.join(root, "personal.db");
    await seedPendingJourney(personal, "personal");
    const mounted = {
      vaultId: "personal",
      label: "Personal",
      canWrite: true,
      databaseName: personal,
    };

    const assertAppRestart = async (readerName: string): Promise<void> => {
      const native = await createNativeReplicaSession({
        gatewayAuth: {
          baseUrl: "http://127.0.0.1:1",
          gatewayId: "offline-gateway",
          vaultId: "personal",
        },
        fetcher: () =>
          Promise.reject(new Error("offline restart must not fetch")),
        changeFeed: inertFeed(),
        driver: new NodeSqliteDriver(personal),
        isConnected: () => false,
        digest: () => Promise.resolve("digest"),
        idFactory: () => `restart-${readerName}`,
      });
      const reader = new MultiVaultReplicaReader(
        new NodeSqliteDriver(path.join(root, readerName)),
        [mounted]
      );
      // This is the exact facade mounted by the mobile app. Tally, Tasks, and
      // Notes begin from empty canonical tables and filter on an optimistic
      // value; Agenda patches an existing canonical row. Together they prove
      // both former failure modes after a full session/store reconstruction.
      const session = new MultiVaultReplicaSession({
        reader,
        sessions: new Map([["personal", native]]),
        scopes: [mounted],
        focusedVaultId: () => "personal",
        createId: () => `placement-${readerName}`,
        sendPlacement: () =>
          Promise.reject(new Error("offline restart must not place")),
        isConnected: () => false,
      });
      try {
        const [expense, task, taskSearch, agenda, note] = await Promise.all([
          session.read("tally", {
            entity: "tally.expense",
            where: [
              {
                column: "description",
                op: "eq",
                value: "Survives restart expense",
              },
            ],
          }),
          session.read("tasks", {
            entity: "schedule.task",
            where: [
              {
                column: "title",
                op: "eq",
                value: "Survives restart task",
              },
            ],
          }),
          session.search("tasks", {
            entity: "schedule.task",
            query: "survives rest",
          }),
          session.read("agenda", {
            entity: "core.event",
            where: [{ column: "event_id", op: "eq", value: "event-offline" }],
          }),
          session.read("notes", {
            entity: "knowledge.note",
            where: [
              {
                column: "title",
                op: "eq",
                value: "Survives restart note",
              },
            ],
          }),
        ]);
        expect(expense.rows[0]?.values).toMatchObject({
          description: "Survives restart expense",
          [PENDING_OVERLAY_FIELDS.key]: "intent-2",
          __centraidScopeId: "personal",
        });
        expect(task.rows[0]?.values).toMatchObject({
          project_id: "pending:intent-1:project",
          title: "Survives restart task",
          [PENDING_OVERLAY_FIELDS.key]: "intent-6",
          __centraidScopeId: "personal",
        });
        expect(
          task.rows[0]?.values.__centraid_pending_supersedes
        ).toBeUndefined();
        expect(taskSearch.rows[0]?.values).toMatchObject({
          title: "Survives restart task",
          [PENDING_OVERLAY_FIELDS.key]: "intent-6",
          __centraidScopeId: "personal",
        });
        expect(agenda.rows[0]?.values).toMatchObject({
          summary: "Offline planning session",
          [PENDING_OVERLAY_FIELDS.key]: "intent-4",
          __centraidScopeId: "personal",
        });
        expect(note.rows[0]?.values).toMatchObject({
          title: "Survives restart note",
          [PENDING_OVERLAY_FIELDS.key]: "intent-5",
          __centraidScopeId: "personal",
        });
        // The status left the row; the read's sidecar carries it (#922 G3).
        for (const [result, intentId] of [
          [expense, "intent-2"],
          [task, "intent-6"],
          [taskSearch, "intent-6"],
          [agenda, "intent-4"],
          [note, "intent-5"],
        ] as const) {
          expect(result.pending?.[intentId]).toMatchObject({
            status: "queued",
          });
        }
      } finally {
        await session.close();
      }
    };

    // RN 0.81/Hermes has no structuredClone. Keep it absent for both cold
    // reads so Node cannot accidentally hide a native-only runtime failure.
    vi.stubGlobal("structuredClone", undefined);
    try {
      await assertAppRestart("first.db");
      await assertAppRestart("restarted.db");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("keeps a writable vault and its item id atomic across equal-sha rows", async () => {
    const root = tempDirSync("centraid-provenance-");
    const personal = path.join(root, "personal.db");
    const shared = path.join(root, "shared.db");
    seed(personal, "personal", "p");
    seed(shared, "shared", "s");
    const reader = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      [
        {
          vaultId: "personal",
          label: "Personal",
          canWrite: false,
          databaseName: personal,
        },
        {
          vaultId: "shared",
          label: "Family",
          canWrite: true,
          databaseName: shared,
        },
      ]
    );

    const row = (
      await reader.read("docs", {
        entity: "core.content_item",
        limit: 100,
      })
    ).rows[0]!.values;

    expect(row.content_id).toBe("content-s");
    expect(row.__centraidScopeId).toBe("shared");
    expect(row.__centraidWritableScopeIds).toStrictEqual(["shared"]);
    expect(row.__centraidScopeIds).toStrictEqual(["personal", "shared"]);
    reader.close();
  });

  test("ATTACHes mounted vaults, federates FTS, and dedupes equal sha provenance", async () => {
    const root = tempDirSync("centraid-mounted-");
    const personal = path.join(root, "personal.db");
    const shared = path.join(root, "shared.db");
    seed(personal, "personal", "p");
    seed(shared, "shared", "s");
    const reader = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      [
        {
          vaultId: "personal",
          label: "Personal",
          canWrite: true,
          databaseName: personal,
        },
        {
          vaultId: "shared",
          label: "Family",
          canWrite: false,
          databaseName: shared,
        },
      ]
    );

    const contents = await reader.read("docs", {
      entity: "core.content_item",
      limit: 100,
    });
    expect(contents.rows).toHaveLength(1);
    expect(contents.rows[0]?.values.__centraidScopeIds).toStrictEqual([
      "personal",
      "shared",
    ]);
    expect(contents.rows[0]?.values.__centraidScopeLabels).toStrictEqual([
      "Personal",
      "Family",
    ]);
    expect(contents.rows[0]?.values.__centraidWritableScopeIds).toStrictEqual([
      "personal",
    ]);
    expect(contents.rows[0]?.values.__centraidCanWrite).toBe(true);

    const results = await reader.search("docs", {
      entity: "core.document",
      query: "house",
    });
    expect(results.rows).toHaveLength(2);
    expect(
      results.rows
        .map((row) => row.values.__centraidScopeId)
        .sort((a, b) => String(a).localeCompare(String(b)))
    ).toStrictEqual(["personal", "shared"]);
    const placement = reader.enqueuePlacement({
      linkToken: "placement-1",
      kind: "move",
      itemType: "core.document",
      itemId: "document-p",
      sourceVaultId: "personal",
      targetVaultId: "shared",
    });
    expect(placement.status).toBe("queued");
    reader.close();

    const reopened = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      [
        {
          vaultId: "personal",
          label: "Personal",
          canWrite: true,
          databaseName: personal,
        },
        {
          vaultId: "shared",
          label: "Family",
          canWrite: false,
          databaseName: shared,
        },
      ]
    );
    expect(reopened.placement("placement-1")).toMatchObject({
      status: "queued",
      sourceVaultId: "personal",
      targetVaultId: "shared",
    });
    reopened.updatePlacement({
      ...reopened.placement("placement-1")!,
      status: "parked",
    });
    expect(reopened.cancelPlacement("placement-1")).toBe(true);
    expect(reopened.placement("placement-1")).toBeUndefined();
    reopened.close();
  });

  test("detaches only a revoked scope and drops its cross-scope outbox work", async () => {
    const root = tempDirSync("centraid-revoked-");
    const personal = path.join(root, "personal.db");
    const shared = path.join(root, "shared.db");
    seed(personal, "personal", "p");
    seed(shared, "shared", "s");
    const reader = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      [
        {
          vaultId: "personal",
          label: "Personal",
          canWrite: true,
          databaseName: personal,
        },
        {
          vaultId: "shared",
          label: "Family",
          canWrite: true,
          databaseName: shared,
        },
      ]
    );
    reader.enqueuePlacement({
      linkToken: "placement-revoked",
      kind: "move",
      itemType: "core.document",
      itemId: "document-s",
      sourceVaultId: "shared",
      targetVaultId: "personal",
    });

    reader.revokeScope("shared");

    expect(reader.scopes().map((scope) => scope.vaultId)).toStrictEqual([
      "personal",
    ]);
    expect(reader.placement("placement-revoked")).toBeUndefined();
    expect(
      (
        await reader.read("docs", { entity: "core.document", limit: 100 })
      ).rows.map((row) => row.values.document_id)
    ).toStrictEqual(["document-p"]);
    reader.close();
  });

  test("reports partial coverage and a conservative cursor when one scope is empty", async () => {
    const root = tempDirSync("centraid-partial-mounted-");
    const ready = path.join(root, "ready.db");
    const empty = path.join(root, "empty.db");
    seed(ready, "ready", "r");
    const emptyStore = new ReplicaSqliteStore(
      new NodeSqliteDriver(empty),
      "empty"
    );
    emptyStore.close();

    const reader = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      [
        {
          vaultId: "ready",
          label: "Ready",
          canWrite: true,
          databaseName: ready,
        },
        {
          vaultId: "empty",
          label: "Empty",
          canWrite: false,
          databaseName: empty,
        },
      ]
    );

    const result = await reader.read("docs", {
      entity: "core.document",
      limit: 100,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.coverage).toBe("partial");
    expect(result.cursor).toStrictEqual({ epoch: "mounted", seq: 0 });
    reader.close();
  });

  test("reports partial coverage when the pushed page ceiling caps the answer", async () => {
    const root = tempDirSync("centraid-page-ceiling-");
    const personal = path.join(root, "personal.db");
    seedBulkDocuments(personal, "personal", 100_001);
    const reader = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      [
        {
          vaultId: "personal",
          label: "Personal",
          canWrite: true,
          databaseName: personal,
        },
      ]
    );

    const asked = await reader.read("docs", {
      entity: "core.document",
      limit: 250_000,
    });

    // The evaluator caps its own page at the same 100,000 rows, so the rows are
    // the rows either way. What would otherwise be silent is that this is not
    // the whole of what the caller asked for.
    expect(asked.rows).toHaveLength(100_000);
    expect(asked.coverage).toBe("partial");
    reader.close();
  }, 60_000);

  test("parses only the outbox rows that can overlay the read", async () => {
    const root = tempDirSync("centraid-overlay-filter-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", "p");
    seedSyntheticOutbox(personal, "personal", { count: 3, startOrder: 0 });
    seedSyntheticOutbox(personal, "personal", {
      count: 4,
      appId: "notes",
      startOrder: 100,
    });
    seedSyntheticOutbox(personal, "personal", {
      count: 5,
      state: "executed",
      startOrder: 200,
    });
    const driver = new RecordingDriver(path.join(root, "mounted.db"));
    const reader = new MultiVaultReplicaReader(driver, [
      {
        vaultId: "personal",
        label: "Personal",
        canWrite: true,
        databaseName: personal,
      },
    ]);

    const page = await reader.read("docs", {
      entity: "core.document",
      limit: 50,
    });

    const outbox = driver.reads.filter((read) =>
      read.sql.includes("FROM scope_0.replica_intent_outbox")
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.sql).toContain("WHERE state IN (?, ?, ?, ?, ?, ?, ?)");
    expect(outbox[0]!.sql).toContain(
      "json_extract(record_json, '$.appId') = ?"
    );
    // Only the three overlay-state Docs intents cross into JavaScript. The
    // other app's four and the five settled ones are never parsed at all.
    expect(outbox[0]!.rows).toBe(3);
    expect(page.rows).toHaveLength(4);
    reader.close();
  });

  // A thousand pending writes used to inflate the per-scope FTS page by a
  // thousand rows; ten thousand used to refuse the read outright.
  const surviving = {
    returned: 20,
    pending: 20,
    ranks: 20,
    canonical: ["document-p"],
  };

  test("federated search survives a thousand pending writes", async () => {
    await expect(searchAtScale(1_000)).resolves.toStrictEqual(surviving);
  });

  test("federated search survives ten thousand pending writes", async () => {
    await expect(searchAtScale(10_000)).resolves.toStrictEqual(surviving);
  }, 30_000);

  test("holds the 50k-item + 200-pending ten-year read/search budgets", async () => {
    const root = tempDirSync("centraid-household-");
    const fixtureScopes = [
      { vaultId: "personal", label: "Personal", canWrite: true as const },
      { vaultId: "family", label: "Family", canWrite: true as const },
      { vaultId: "school", label: "School", canWrite: false as const },
      { vaultId: "club", label: "Club", canWrite: false as const },
    ].map((scope) => ({
      ...scope,
      databaseName: path.join(root, `${scope.vaultId}.db`),
    }));
    for (const scope of fixtureScopes)
      seedTenYearLibrary(scope.databaseName, scope.vaultId, 12_500);
    await Promise.all(
      fixtureScopes.map((scope) =>
        seedPendingDocuments(scope.databaseName, scope.vaultId, 50)
      )
    );
    const reader = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      fixtureScopes
    );
    expect(reader.scopes()).toHaveLength(MAX_MOUNTED_NATIVE_SCOPES);

    const coldStarted = performance.now();
    const recent = await reader.read("docs", {
      entity: "core.document",
      orderBy: { column: "updated_at", dir: "desc" },
      limit: 5_000,
    });
    const coldMs = performance.now() - coldStarted;
    expect(recent.rows).toHaveLength(5_000);
    // The dedicated evidence lane owns the product budgets. The full Vitest
    // fan-out competes with 37 other files for the same CPU, so it retains a
    // broader smoke ceiling instead of turning scheduler contention into a
    // false regression.
    const strict = process.env.CENTRAID_PERF_EVIDENCE === "1";
    expect(coldMs).toBeLessThan(strict ? 1_000 : 15_000);

    const searchStarted = performance.now();
    const matches = await reader.search("docs", {
      entity: "core.document",
      query: "needlepersonal",
      limit: 100,
    });
    const searchMs = performance.now() - searchStarted;
    expect(matches.rows).toHaveLength(1);
    expect(searchMs).toBeLessThan(strict ? 100 : 500);

    const projectionBytes = fixtureScopes.reduce(
      (total, scope) => total + statSync(scope.databaseName).size,
      0
    );
    const bootstrapPageBytes = Math.ceil(
      (projectionBytes / 50_000) * MOBILE_REPLICA_BOOTSTRAP_WINDOW
    );
    // The checked thumbnail policy is recent 90 days plus favorites. Five
    // percent favorites is intentionally conservative for a 12.5k-source
    // slice; recent non-favorites are prorated over the measured ten years.
    const estimatedPinnedThumbnailsPerSource =
      Math.ceil(12_500 * 0.05) + Math.ceil((12_500 / (365.25 * 10)) * 90);
    const thumbnailSamples = measuredThumbnailBytes().sort((a, b) => a - b);
    const thumbnailP95Bytes =
      thumbnailSamples[Math.ceil(thumbnailSamples.length * 0.95) - 1]!;
    const estimatedThumbnailPackBytes =
      thumbnailP95Bytes * estimatedPinnedThumbnailsPerSource;
    if (process.env.CENTRAID_PERF_EVIDENCE === "1") {
      console.info(
        JSON.stringify(
          {
            coldMs,
            searchMs,
            projectionBytes,
            mountedScopes: reader.scopes().length,
            pendingMutations: 200,
            bootstrapWindowRows: MOBILE_REPLICA_BOOTSTRAP_WINDOW,
            bootstrapPageBytes,
            thumbnailP95Bytes,
            estimatedPinnedThumbnailsPerSource,
            estimatedThumbnailPackBytes,
            thumbnailBudgetBytes: THUMBNAIL_SOURCE_BUDGET_BYTES,
          },
          null,
          2
        )
      );
    }
    expect(projectionBytes).toBeLessThan(128 * 1024 * 1024);
    expect(bootstrapPageBytes).toBeLessThan(4 * 1024 * 1024);
    expect(estimatedThumbnailPackBytes).toBeLessThan(
      THUMBNAIL_SOURCE_BUDGET_BYTES
    );
    reader.close();
  }, 45_000);
});

/**
 * THE MOUNTED READER'S OWN TRUNCATION VERDICT (#922 0a, verifier follow-up 3).
 *
 * The reader answers with `page.truncated || rows.length > requested`, and the
 * second half is not reachable from the store's tests: it is dedupe/badge
 * composition leaving MORE than the caller asked for, which only a mounted
 * plane can produce. Both halves are exercised here against real SQLite, with
 * the short-page case beside them so a verdict that simply said `true` fails.
 */
describe("mounted read truncation", () => {
  /** One mounted plane over the given vault files, in mount order. */
  const mount = (
    root: string,
    ...vaults: Array<{ vaultId: string; label: string; file: string }>
  ): MultiVaultReplicaReader =>
    new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      vaults.map((vault) => ({
        vaultId: vault.vaultId,
        label: vault.label,
        canWrite: true,
        databaseName: vault.file,
      }))
    );

  const openBulk = (count: number): MultiVaultReplicaReader => {
    const root = tempDirSync(`centraid-mounted-truncation-${count}-`);
    const personal = path.join(root, "personal.db");
    seedBulkDocuments(personal, "personal", count);
    return mount(root, {
      vaultId: "personal",
      label: "Personal",
      file: personal,
    });
  };

  test("a window the statement fills is reported with the window applied", async () => {
    const reader = openBulk(12);
    const result = await reader.read("docs", {
      entity: "core.document",
      limit: 5,
    });
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.appliedLimit).toBe(5);
    reader.close();
  });

  test("a page under the window hides nothing and says nothing", async () => {
    const reader = openBulk(3);
    const result = await reader.read("docs", {
      entity: "core.document",
      limit: 50,
    });
    // The bulk fixture's own seeded document rides along with the bulk rows.
    expect(result.rows.length).toBeLessThan(50);
    expect(result.truncated).toBeUndefined();
    expect(result.appliedLimit).toBeUndefined();
    reader.close();
  });

  test("badge composition leaving more than asked is truncation too", async () => {
    // `core.content_item` carries `sha256`, so its limit is NOT pushed into
    // SQLite: the reader reads the whole filtered set at the local ceiling and
    // composes badges after. The statement's own probe therefore never fires,
    // and the verdict can only come from `rows.length > requested` — the half
    // no store-level test can reach.
    const root = tempDirSync("centraid-mounted-badge-truncation-");
    const personal = path.join(root, "personal.db");
    const family = path.join(root, "family.db");
    seed(personal, "personal", "p");
    seed(family, "family", "f");
    // A second content item, distinct bytes, so it cannot collapse into the
    // badged pair the two vaults already share.
    const extra = new DatabaseSync(personal);
    extra
      .prepare(
        `INSERT INTO replica_row
           (shape_id, entity, row_id, payload_json, oversized_json)
         VALUES ('docs-default', 'core.content_item', ?, ?, '[]')`
      )
      .run(
        "content-distinct",
        JSON.stringify({
          content_id: "content-distinct",
          title: "Lease",
          sha256: "other-bytes",
          media_type: "application/pdf",
          byte_size: 7,
          created_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
        })
      );
    extra.close();
    const reader = mount(
      root,
      { vaultId: "personal", label: "Personal", file: personal },
      { vaultId: "family", label: "Family", file: family }
    );
    // Two composed rows: the badged pair the vaults share, and the distinct one.
    const whole = await reader.read("docs", {
      entity: "core.content_item",
      limit: 50,
    });
    expect(whole.rows).toHaveLength(2);
    expect(whole.truncated).toBeUndefined();

    const narrow = await reader.read("docs", {
      entity: "core.content_item",
      limit: 1,
    });
    expect(narrow.rows).toHaveLength(1);
    expect(narrow.truncated).toBe(true);
    expect(narrow.appliedLimit).toBe(1);
    reader.close();
  });
});
