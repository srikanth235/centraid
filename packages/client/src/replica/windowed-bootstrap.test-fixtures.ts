// Shared fixture vocabulary for the windowed-bootstrap suites: the forward walk
// in `windowed-bootstrap.test.ts` and the interruption/restart paths in
// `windowed-bootstrap-resume.test.ts`. Both drive the same target double and
// the same scripted page server, so the doubles live here rather than drifting
// apart by copy-paste across two files the repo file-size cap keeps separate.
import type { GatewayAuth } from "../gateway-auth.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import type {
  IntentOutcome,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaSnapshotRow,
} from "./types.js";
import type { WindowedBootstrapTarget } from "./windowed-bootstrap.js";

export const gatewayAuth: GatewayAuth = {
  baseUrl: "http://127.0.0.1:18789",
  gatewayId: "gateway-1",
  vaultId: "vault-a",
};

export const shapes = [
  {
    shapeId: "shape-photos",
    appId: "photos",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "core.content_item",
        primaryKey: "content_id",
        columns: ["content_id", "title"],
      },
    ],
  },
];

export function row(id: string): ReplicaSnapshotRow {
  return {
    shapeId: "shape-photos",
    entity: "core.content_item",
    rowId: id,
    values: { content_id: id, title: id },
  };
}

/**
 * Records the page-wise calls the driver makes so the walk can be asserted, and
 * keeps the walk position the way the SQLite store does — so a target reused
 * across two `runWindowedBootstrap` calls models a killed and reopened process.
 */
export function createTarget(): WindowedBootstrapTarget & {
  readonly rows: ReplicaSnapshotRow[];
  readonly applied: ReplicaChangeBatch[];
  readonly pageCalls: number[];
  header?: ReplicaBootstrapHeader;
  committedAt?: ReplicaCursor;
  committedOutcomes?: IntentOutcome[];
  progress?: {
    schemaEpoch: string;
    after: string | null;
    commitCursor: ReplicaCursor;
    pages: number;
  };
  cursor: ReplicaCursor;
} {
  const rows: ReplicaSnapshotRow[] = [];
  const applied: ReplicaChangeBatch[] = [];
  const pageCalls: number[] = [];
  return {
    rows,
    applied,
    pageCalls,
    cursor: { epoch: "replica-1", seq: 0 },
    async bootstrapBegin(header, options) {
      this.header = header;
      const open = this.progress;
      if (
        options?.restart !== true &&
        open &&
        open.schemaEpoch === header.schemaEpoch
      ) {
        return { ...open };
      }
      rows.length = 0;
      this.progress = undefined;
      return undefined;
    },
    async bootstrapPage(next, advance) {
      // Upsert, like the store: a resumed walk re-applies page one.
      for (const incoming of next) {
        const index = rows.findIndex((item) => item.rowId === incoming.rowId);
        if (index >= 0) rows[index] = incoming;
        else rows.push(incoming);
      }
      pageCalls.push(next.length);
      if (!advance) return;
      this.progress = {
        schemaEpoch: this.header?.schemaEpoch ?? "",
        after: advance.after,
        // The store COALESCEs: page one's cursor wins for the whole walk.
        commitCursor: this.progress?.commitCursor ?? advance.commitCursor,
        pages: advance.pages,
      };
    },
    async bootstrapCommit(cursor, header, outcomes) {
      this.committedAt = cursor;
      this.header = header;
      this.committedOutcomes = outcomes ?? [];
      this.cursor = cursor;
      this.progress = undefined;
      return cursor;
    },
    async applyChanges(batch) {
      applied.push(batch);
      for (const change of batch.changes) {
        if (change.op === "delete") {
          const index = rows.findIndex((item) => item.rowId === change.rowId);
          if (index >= 0) rows.splice(index, 1);
        } else rows.push(change);
      }
      this.cursor = batch.to;
      return batch.to;
    },
  };
}

/** A fetcher serving scripted bootstrap pages keyed by the `after` token. */
export function createFetcher(
  pages: Record<string, unknown>,
  status: Record<string, number> = {}
) {
  const requests: string[] = [];
  const fetcher: ReplicaFetcher = (_baseUrl, pathname) => {
    requests.push(pathname);
    const after = new URL(pathname, "http://x").searchParams.get("after") ?? "";
    const body = pages[after];
    const code = status[after] ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: "missing_page" }), {
        status: code,
        headers: { "content-type": "application/json" },
      })
    );
  };
  return { fetcher, requests };
}

export const emptyBatch = (cursor: ReplicaCursor): ReplicaChangeBatch => ({
  protocolVersion: 1,
  schemaEpoch: "schema-1",
  from: cursor,
  to: cursor,
  changes: [],
});
