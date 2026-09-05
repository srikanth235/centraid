/*
 * Does the store core freeze the JS thread? (#922 E1)
 *
 * On this seat the core runs in the app's own JS context, so a bootstrap page
 * or a reconnect's edits applied statement-by-statement hold the thread for
 * the whole transaction — the screen does not scroll, a tap does not register.
 * The measurement is the LONGEST STRETCH the thread went unyielded while the
 * work landed: the on-device frame sampler is the device rung's, but a JS
 * thread that never yields cannot draw a frame on any device.
 */
import { describe, expect, test } from "vitest";

import { NativeReplicaStore } from "./native-replica-store";
import { NodeSqliteDriver } from "./node-sqlite-driver";

const SHAPE = {
  shapeId: "shape-notes",
  appId: "notes",
  entities: [
    {
      entity: "knowledge.note",
      primaryKey: "note_id",
      columns: ["note_id", "title", "updated_at"],
    },
  ],
};

const PAGE_ROWS = 5_000;
const EDITS = 40;

/**
 * Sample the JS thread while `work` runs and return the longest gap between
 * two consecutive turns of the event loop. A synchronous transaction shows up
 * as one gap the length of the whole apply.
 */
async function longestBlockMs(work: () => Promise<unknown>): Promise<number> {
  let longest = 0;
  let last = Date.now();
  let sampling = true;
  const sample = (): void => {
    if (!sampling) return;
    const now = Date.now();
    longest = Math.max(longest, now - last);
    last = now;
    setImmediate(sample);
  };
  setImmediate(sample);
  // Let one tick land first, and one after: without the trailing turn a
  // fully synchronous apply is never sampled at all and reads as zero.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  last = Date.now();
  await work();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  sampling = false;
  return longest;
}

function page(count: number): {
  shapeId: string;
  entity: string;
  rowId: string;
  values: Record<string, string>;
  rowVersion: number;
}[] {
  return Array.from({ length: count }, (_, index) => ({
    shapeId: SHAPE.shapeId,
    entity: "knowledge.note",
    rowId: `note-${index}`,
    values: {
      note_id: `note-${index}`,
      title: `Note ${index}`,
      updated_at: "2026-09-01",
    },
    rowVersion: index + 1,
  }));
}

describe("the store core off the JS thread", () => {
  test("a first-launch bootstrap page yields the thread while it lands", async () => {
    const store = NativeReplicaStore.create(new NodeSqliteDriver(), "vault");
    await store.bootstrapBegin({
      protocolVersion: 1,
      vaultId: "vault",
      schemaEpoch: "1",
      shapes: [SHAPE],
    });
    const blocked = await longestBlockMs(() =>
      store.bootstrapPage(page(PAGE_ROWS), {
        after: `note-${PAGE_ROWS - 1}`,
        pages: 1,
        commitCursor: { epoch: "epoch", seq: PAGE_ROWS },
      })
    );
    const applied = await store.bootstrapCommit({
      epoch: "epoch",
      seq: PAGE_ROWS,
    });
    expect(applied).toStrictEqual({ epoch: "epoch", seq: PAGE_ROWS });
    // The batch is chunked across event-loop turns, so no single stretch can
    // be the whole page. The bound is generous on purpose: what it refuses is
    // a page-long freeze, not a slow machine.
    expect(blocked).toBeLessThan(400);
    await store.close();
  });

  test("a 40-edit reconnect applies without one long stretch", async () => {
    const store = NativeReplicaStore.create(new NodeSqliteDriver(), "vault");
    await store.bootstrap({
      protocolVersion: 1,
      vaultId: "vault",
      schemaEpoch: "1",
      cursor: { epoch: "epoch", seq: 1 },
      shapes: [SHAPE],
      rows: page(EDITS),
    });
    let result!: Awaited<ReturnType<typeof store.applyChanges>>;
    const blocked = await longestBlockMs(async () => {
      result = await store.applyChanges({
        protocolVersion: 1,
        schemaEpoch: "1",
        from: { epoch: "epoch", seq: 1 },
        to: { epoch: "epoch", seq: 1 + EDITS },
        changes: page(EDITS).map((row, index) => ({
          op: "upsert" as const,
          shapeId: row.shapeId,
          entity: row.entity,
          rowId: row.rowId,
          values: { ...row.values, title: `Edited ${index}` },
          rowVersion: 1 + EDITS + index,
        })),
      });
    });
    expect(blocked).toBeLessThan(400);
    expect(result.cursor).toStrictEqual({ epoch: "epoch", seq: 1 + EDITS });
    expect(result.invalidations).toHaveLength(EDITS);
    const read = await store.read({
      shapeId: SHAPE.shapeId,
      entity: "knowledge.note",
    });
    process.stdout.write(`READ ${JSON.stringify(read).slice(0, 300)}
`);
    expect(read.rows).toHaveLength(EDITS);
    await store.close();
  });
});
