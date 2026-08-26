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
          [PENDING_OVERLAY_FIELDS.status]: "queued",
          __centraidScopeId: "personal",
        });
        expect(task.rows[0]?.values).toMatchObject({
          project_id: "pending:intent-1:project",
          title: "Survives restart task",
          [PENDING_OVERLAY_FIELDS.key]: "intent-6",
          [PENDING_OVERLAY_FIELDS.status]: "queued",
          __centraidScopeId: "personal",
        });
        expect(
          task.rows[0]?.values.__centraid_pending_supersedes
        ).toBeUndefined();
        expect(taskSearch.rows[0]?.values).toMatchObject({
          title: "Survives restart task",
          [PENDING_OVERLAY_FIELDS.key]: "intent-6",
          [PENDING_OVERLAY_FIELDS.status]: "queued",
          __centraidScopeId: "personal",
        });
        expect(agenda.rows[0]?.values).toMatchObject({
          summary: "Offline planning session",
          [PENDING_OVERLAY_FIELDS.key]: "intent-4",
          [PENDING_OVERLAY_FIELDS.status]: "queued",
          __centraidScopeId: "personal",
        });
        expect(note.rows[0]?.values).toMatchObject({
          title: "Survives restart note",
          [PENDING_OVERLAY_FIELDS.key]: "intent-5",
          [PENDING_OVERLAY_FIELDS.status]: "queued",
          __centraidScopeId: "personal",
        });
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
