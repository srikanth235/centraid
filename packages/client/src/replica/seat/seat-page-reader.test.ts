// THE SHELL'S END OF A PAGED HANDLER, RED FIRST (#996 wave 4).
//
// The seat holds the whole vault, so an app read is SQL over the file — but the
// file is behind a worker, and the shell's end of that boundary is async. The
// claims are the ones that keep the two ends from becoming two implementations:
//
//   1. the statement the worker runs is the SAME statement the in-process host
//      would run — one assembler, so a keyset cannot drift between the seat's
//      own reads and the shell's;
//   2. the overlay reaches the worker. A read that drops it shows the member the
//      gateway's rows and not their own unsettled write, which is the failure
//      R23–R25 exist to prevent, and it is silent;
//   3. the probe row is dropped and the cursor derived on this side, so the
//      worker returns rows and nothing else — no second result shape to keep
//      in step across the boundary.

import { describe, expect, it } from "vitest";

import { pageStatement } from "@centraid/core/page";

import { seatWorkerPage } from "./seat-page-reader.js";
import type { SeatWorkerQuery } from "./worker-protocol.js";

interface NoteRow {
  note_id: string;
  updated_at: string;
}

const recent = {
  name: "notes.recent",
  select: "note_id, updated_at",
  from: "note",
  where: "deleted_at IS NULL",
  order: { sortColumn: "updated_at", pkColumn: "note_id", descending: true },
} as const;

function fakeClient(rows: NoteRow[]): {
  query: <T extends object>(request: SeatWorkerQuery) => Promise<T[]>;
  seen: SeatWorkerQuery[];
} {
  const seen: SeatWorkerQuery[] = [];
  return {
    seen,
    query: <T extends object>(request: SeatWorkerQuery): Promise<T[]> => {
      seen.push(request);
      return Promise.resolve(rows as unknown as T[]);
    },
  };
}

const rows = (n: number): NoteRow[] =>
  Array.from({ length: n }, (_, i) => ({
    note_id: `n${String(i).padStart(3, "0")}`,
    updated_at: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
  }));

describe("the shell's paged read over the seat worker", () => {
  it("sends exactly the statement the in-process host would run", async () => {
    const client = fakeClient(rows(3));
    await seatWorkerPage<NoteRow>(client, recent, { limit: 10 });
    const expected = pageStatement(recent, { limit: 10 });
    expect(client.seen[0]?.sql).toBe(expected.sql);
    expect(client.seen[0]?.bind).toStrictEqual(expected.bind);
  });

  it("carries the keyset of a continuation into the statement", async () => {
    const client = fakeClient(rows(3));
    await seatWorkerPage<NoteRow>(client, recent, {
      limit: 10,
      after: { sortKey: "2026-01-05T00:00:00Z", pk: "n042" },
    });
    expect(client.seen[0]?.sql).toContain("(updated_at, note_id) < (?, ?)");
    expect(client.seen[0]?.bind).toStrictEqual([
      "2026-01-05T00:00:00Z",
      "n042",
      11,
    ]);
  });

  it("passes the overlay through, so a member sees their own pending write", async () => {
    const client = fakeClient(rows(3));
    await seatWorkerPage<NoteRow>(
      client,
      recent,
      { limit: 10 },
      { entity: "knowledge.note", rowIdColumn: "note_id" }
    );
    expect(client.seen[0]?.overlay).toStrictEqual({
      entity: "knowledge.note",
      rowIdColumn: "note_id",
    });
  });

  it("omits the overlay when the read is measuring the file, not showing it", async () => {
    const client = fakeClient(rows(3));
    await seatWorkerPage<NoteRow>(client, recent, { limit: 10 });
    expect(client.seen[0]).not.toHaveProperty("overlay");
  });

  it("drops the probe row and derives the cursor on this side", async () => {
    const client = fakeClient(rows(11));
    const page = await seatWorkerPage<NoteRow>(client, recent, { limit: 10 });
    expect(page.rows).toHaveLength(10);
    expect(page.next).toStrictEqual({
      sortKey: page.rows[9]!.updated_at,
      pk: page.rows[9]!.note_id,
    });
  });

  it("ends the walk when the rows ran out inside the window", async () => {
    const client = fakeClient(rows(4));
    const page = await seatWorkerPage<NoteRow>(client, recent, { limit: 10 });
    expect(page.rows).toHaveLength(4);
    expect(page.next).toBeUndefined();
  });
});
