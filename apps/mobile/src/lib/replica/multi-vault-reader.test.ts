import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { encode as encodeJpeg } from "jpeg-js";
import { describe, expect, test } from "vitest";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "./multi-vault-reader";
import { NodeSqliteDriver } from "./node-sqlite-driver";
import {
  MAX_MOUNTED_NATIVE_SCOPES,
  MOBILE_REPLICA_BOOTSTRAP_WINDOW,
  THUMBNAIL_SOURCE_BUDGET_BYTES,
} from "./offline-budgets";

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
          role: "read",
          databaseName: personal,
        },
        {
          vaultId: "shared",
          label: "Family",
          role: "write",
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
          role: "admin",
          databaseName: personal,
        },
        {
          vaultId: "shared",
          label: "Family",
          role: "read",
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
          role: "admin",
          databaseName: personal,
        },
        {
          vaultId: "shared",
          label: "Family",
          role: "read",
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
          role: "write",
          databaseName: personal,
        },
        {
          vaultId: "shared",
          label: "Family",
          role: "write",
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
          role: "write",
          databaseName: ready,
        },
        {
          vaultId: "empty",
          label: "Empty",
          role: "read",
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

  test("holds the 50k-item ten-year cold-read and local-search budgets", async () => {
    const root = tempDirSync("centraid-household-");
    const fixtureScopes = [
      { vaultId: "personal", label: "Personal", role: "admin" as const },
      { vaultId: "family", label: "Family", role: "write" as const },
      { vaultId: "school", label: "School", role: "read" as const },
      { vaultId: "club", label: "Club", role: "read" as const },
    ].map((scope) => ({
      ...scope,
      databaseName: path.join(root, `${scope.vaultId}.db`),
    }));
    for (const scope of fixtureScopes)
      seedTenYearLibrary(scope.databaseName, scope.vaultId, 12_500);
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
