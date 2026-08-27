// Snapshot fixtures shared by the ReplicaSqliteStore suites: the row/change/search
// conformance in `store-core.test.ts`, the windowed-walk and reclamation
// conformance in `store-core-bootstrap-walk.test.ts`, and the node-driver
// maintenance suite in `store-core-storage-lifecycle.test.ts`. One corpus, so the
// three files the repo file-size cap keeps apart cannot drift apart in what they
// bootstrap.
import type { ReplicaSnapshot } from "./types.js";

export function snapshot(): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-1",
    cursor: { epoch: "replica-1", seq: 2 },
    shapes: [
      {
        shapeId: "shape-agenda",
        appId: "agenda",
        purpose: "dpv:ServiceProvision",
        entities: [
          {
            entity: "core.event",
            primaryKey: "event_id",
            columns: ["event_id", "title", "status", "starts_at", "body"],
            hasUnavailableFields: true,
          },
        ],
      },
    ],
    rows: [
      {
        shapeId: "shape-agenda",
        entity: "core.event",
        rowId: "event-1",
        values: {
          event_id: "event-1",
          title: "Earlier",
          status: "open",
          starts_at: "2026-07-15T08:00:00.000Z",
        },
        oversizedFields: ["body"],
      },
      {
        shapeId: "shape-agenda",
        entity: "core.event",
        rowId: "event-2",
        values: {
          event_id: "event-2",
          title: "Later",
          status: "open",
          starts_at: "2026-07-15T10:00:00.000Z",
          body: "small",
        },
      },
    ],
  };
}

export function searchableSnapshot(): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-search",
    cursor: { epoch: "replica-search", seq: 1 },
    shapes: [
      {
        shapeId: "shape-photos",
        appId: "photos",
        purpose: "dpv:ServiceProvision",
        entities: [
          {
            entity: "core.content_item",
            primaryKey: "content_id",
            columns: ["content_id", "title", "deleted_at", "created_at"],
          },
        ],
      },
    ],
    rows: [
      {
        shapeId: "shape-photos",
        entity: "core.content_item",
        rowId: "photo-new",
        values: {
          content_id: "photo-new",
          title: "Today at the park",
          deleted_at: null,
          created_at: "2026-07-15T10:00:00.000Z",
        },
      },
      {
        shapeId: "shape-photos",
        entity: "core.content_item",
        rowId: "photo-off-window",
        values: {
          content_id: "photo-off-window",
          title: "Moonlit campsite in Ladakh",
          deleted_at: null,
          created_at: "2024-01-01T10:00:00.000Z",
        },
      },
    ],
  };
}

/** A snapshot fat enough that its pages are visible in `PRAGMA page_count`. */
export function bulkSnapshot(rows: number): ReplicaSnapshot {
  const base = searchableSnapshot();
  return {
    ...base,
    rows: Array.from({ length: rows }, (_, index) => ({
      shapeId: "shape-photos",
      entity: "core.content_item",
      rowId: `photo-${index}`,
      values: {
        content_id: `photo-${index}`,
        title: `Kodaikanal terrace garden in the monsoon ${index}`.repeat(4),
        deleted_at: null,
        created_at: "2026-07-15T10:00:00.000Z",
      },
    })),
  };
}

/** The same, over an entity the local FTS index does not cover. */
export function bulkEventSnapshot(rows: number): ReplicaSnapshot {
  const base = snapshot();
  return {
    ...base,
    rows: Array.from({ length: rows }, (_, index) => ({
      shapeId: "shape-agenda",
      entity: "core.event",
      rowId: `event-${index}`,
      values: {
        event_id: `event-${index}`,
        title: `Terrace garden repotting ${index}`.repeat(4),
        status: "open",
        starts_at: "2026-07-15T08:00:00.000Z",
      },
    })),
  };
}
