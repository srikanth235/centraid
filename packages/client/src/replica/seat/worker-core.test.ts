import path from "node:path";

import { describe, expect, it } from "vitest";

import type { SeatLogPageWire } from "@centraid/core/protocol";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import type { SeatChangeNotice } from "./applier.js";
import { httpSeatSnapshotTransport } from "./http-snapshot-transport.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { nodeSeatStaging } from "./node-staging.js";
import {
  seatArtifact,
  seatArtifactTransport,
} from "./seat-artifact.test-fixtures.js";
import { SeatWorkerNotOpenError } from "./seat-worker-not-open-error.js";
import { SeatWorkerCore } from "./worker-core.js";

function workspace(): string {
  return tempDirSync("seat-worker-");
}

function core(
  root: string,
  changes: SeatChangeNotice[]
): { core: SeatWorkerCore; open: () => void } {
  const drivers: NodeSeatDriver[] = [];
  const bytes = seatArtifact(root);
  const worker = new SeatWorkerCore(
    {
      openDatabase: () => {
        const driver = new NodeSeatDriver(path.join(root, "seat.db"));
        drivers.push(driver);
        return driver;
      },
      staging: () =>
        nodeSeatStaging({
          directory: path.join(root, "staging"),
          databasePath: path.join(root, "seat.db"),
        }),
      transport: () => seatArtifactTransport(bytes, 7),
    },
    { onChange: (notice) => changes.push(notice) }
  );
  return { core: worker, open: () => drivers.at(-1)?.close() };
}

const OPEN = {
  vaultId: "vault-1",
  dbName: "/seat.db",
  remember: true,
} as const;

function page(rows: SeatLogPageWire["rows"]): SeatLogPageWire {
  return {
    vaultId: "vault-1",
    epoch: "e1",
    schemaEpoch: 2,
    ddlVersion: 0,
    floor: 0,
    watermark: rows.at(-1)?.seq ?? 7,
    next: rows.at(-1)?.seq ?? 7,
    hasMore: false,
    rows,
  };
}

describe("the seat worker core", () => {
  it("answers undefined for a seat that holds no copy yet", async () => {
    const root = workspace();
    const changes: SeatChangeNotice[] = [];
    const { core: worker } = core(root, changes);
    await expect(worker.open(OPEN)).resolves.toBeUndefined();
    worker.close();
  });

  it("bootstraps, applies and notifies — the whole seat loop through one seam", async () => {
    const root = workspace();
    const changes: SeatChangeNotice[] = [];
    const { core: worker } = core(root, changes);
    await worker.open(OPEN);
    const bootstrapped = await worker.bootstrap({
      vaultId: "vault-1",
      snapshotUrl: "/snapshot",
    });
    expect(bootstrapped.seq).toBe(7);
    expect(worker.state()).toMatchObject({ appliedSeq: 7, epoch: "e1" });

    const summary = worker.apply({
      page: page([
        {
          seq: 8,
          commitSeq: 3,
          schemaEpoch: 2,
          ddlVersion: 0,
          table: "note",
          op: "insert",
          pk: ["n2"],
          row: { note_id: "n2", title: "applied on the seat" },
          producer: "test",
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });
    expect(summary.applied).toBe(1);
    expect(changes).toStrictEqual([
      { tables: ["note"], cursor: 8, commitSeqs: [3] },
    ]);
    expect(
      worker.query({ sql: `SELECT count(*) AS n FROM note` })
    ).toStrictEqual([{ n: 2 }]);
    worker.close();
  });

  /*
   * THE PHONE'S OWN NOTE, BEFORE AND AFTER THE ECHO (#996, R24).
   *
   * Red-first against the emulator gate: a note saved on the phone never
   * appeared in the Notes list. Two halves, and both are here — the seat's
   * read was raw SQL over the GATEWAY's rows, so a write that had not made the
   * round trip appeared nowhere; and nothing in production ever called
   * `seatOverlayClearingHook`, so once the answer did arrive the overlay was
   * parked on its `commit_seq` with nothing to clear it.
   */
  async function seated(root: string): Promise<{
    worker: SeatWorkerCore;
    cleared: string[][];
  }> {
    const cleared: string[][] = [];
    const drivers: NodeSeatDriver[] = [];
    const bytes = seatArtifact(root);
    const worker = new SeatWorkerCore(
      {
        openDatabase: () => {
          const driver = new NodeSeatDriver(path.join(root, "seat.db"));
          drivers.push(driver);
          return driver;
        },
        staging: () =>
          nodeSeatStaging({
            directory: path.join(root, "staging"),
            databasePath: path.join(root, "seat.db"),
          }),
        transport: () => seatArtifactTransport(bytes, 7),
      },
      { onOverlaysCleared: (ids) => cleared.push([...ids]) }
    );
    await worker.open(OPEN);
    await worker.bootstrap({ vaultId: "vault-1", snapshotUrl: "/snapshot" });
    return { worker, cleared };
  }

  /** The list the phone's Notes screen reads. */
  const NOTES = {
    sql: `SELECT note_id, title FROM note ORDER BY note_id`,
    overlay: { entity: "knowledge.note", rowIdColumn: "note_id" },
  } as const;

  /** The intent behind "save", answered `executed` at commit 9. */
  async function savedNote(worker: SeatWorkerCore): Promise<void> {
    const store = worker.outbox();
    await store.add({
      intentId: "intent-note",
      appId: "knowledge",
      action: "create_note",
      input: { title: "written on the train" },
      payloadHash: "n".repeat(64),
      state: "awaiting-change",
      attempts: 0,
      commitSeq: 9,
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-notes",
          entity: "knowledge.note",
          rowId: "n2",
          values: { note_id: "n2", title: "written on the train" },
        },
      ],
      dependencies: [],
    });
  }

  it("shows the member's own note before the echo, and the canonical row after it", async () => {
    const root = workspace();
    const { worker, cleared } = await seated(root);
    await savedNote(worker);

    // BEFORE THE ECHO. The file holds only the gateway's row; the list the
    // member reads holds theirs too, or the save looks like it was swallowed.
    //
    // AND THE MEMBER'S OWN ROW SAYS SO (#996 wave 4b). It carries the intent
    // that projected it — the one pending column a handler's projection can
    // carry through (#922 G3) — and the read's facts about that intent. Without
    // both, `readPendingOverlay` refuses to draw a badge, and a queued row
    // renders as a settled one: exactly the swallowed save this test is about,
    // one step later.
    expect(worker.query(NOTES)).toStrictEqual([
      { note_id: "n1", title: "from the gateway" },
      {
        note_id: "n2",
        title: "written on the train",
        __centraid_pending_key: "intent-note",
        __seatPendingFacts: {
          "intent-note": {
            status: "sending",
            action: "create_note",
            reason: "Sending this change.",
            attempts: 0,
            enqueuedAt: expect.any(String) as unknown as string,
          },
        },
      },
    ]);
    // The canonical row beside it carries neither: the sidecar is bounded by
    // the outbox, not by the page.
    expect(worker.query(NOTES)[0]).not.toHaveProperty("__seatPendingFacts");
    // The canonical read — the one that measures the file — still says one.
    expect(
      worker.query({ sql: `SELECT count(*) AS n FROM note` })
    ).toStrictEqual([{ n: 1 }]);

    // A page that does NOT carry commit 9 leaves the overlay standing.
    worker.apply({
      page: page([
        {
          seq: 8,
          commitSeq: 8,
          schemaEpoch: 2,
          ddlVersion: 0,
          table: "note",
          op: "insert",
          pk: ["n3"],
          row: { note_id: "n3", title: "someone else's" },
          producer: "test",
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });
    expect(cleared).toStrictEqual([]);
    // A row that exists only in the outbox cannot be placed by the read's own
    // ORDER BY — it is not in the file — so it appends. The member sees it;
    // where it sits settles when the echo lands.
    expect(
      worker.query(NOTES).map((row) => (row as { note_id: string }).note_id)
    ).toStrictEqual(["n1", "n3", "n2"]);

    // THE ECHO. The commit carrying the note arrives; the overlay clears in
    // the same transaction, and the row the list returns is the canonical one.
    worker.apply({
      page: page([
        {
          seq: 9,
          commitSeq: 9,
          schemaEpoch: 2,
          ddlVersion: 0,
          table: "note",
          op: "insert",
          pk: ["n2"],
          row: { note_id: "n2", title: "written on the train" },
          producer: "test",
          committedAt: "2026-01-01T00:00:01.000Z",
        },
      ]),
    });
    expect(cleared).toStrictEqual([["intent-note"]]);
    expect(worker.query(NOTES)).toStrictEqual([
      { note_id: "n1", title: "from the gateway" },
      { note_id: "n2", title: "written on the train" },
      { note_id: "n3", title: "someone else's" },
    ]);
    // …and it is the FILE's row now, not an overlay drawn over it.
    expect(
      worker.query({ sql: `SELECT count(*) AS n FROM note` })
    ).toStrictEqual([{ n: 3 }]);
    worker.close();
  });

  it("refuses to bootstrap before it has been opened", async () => {
    const root = workspace();
    const { core: worker } = core(root, []);
    await expect(
      worker.bootstrap({ vaultId: "vault-1", snapshotUrl: "/snapshot" })
    ).rejects.toBeInstanceOf(SeatWorkerNotOpenError);
  });

  it("reopens the file after a re-bootstrap rather than holding the replaced one", async () => {
    const root = workspace();
    const { core: worker } = core(root, []);
    await worker.open(OPEN);
    await worker.bootstrap({ vaultId: "vault-1", snapshotUrl: "/snapshot" });
    worker.apply({
      page: page([
        {
          seq: 8,
          commitSeq: 3,
          schemaEpoch: 2,
          ddlVersion: 0,
          table: "note",
          op: "insert",
          pk: ["n2"],
          row: { note_id: "n2", title: "before" },
          producer: "test",
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });
    await worker.bootstrap({ vaultId: "vault-1", snapshotUrl: "/snapshot" });
    // The replaced file's extra row is gone, and the cursor is the snapshot's:
    // a handle held across the swap would still be answering from the old one.
    expect(
      worker.query({ sql: `SELECT count(*) AS n FROM note` })
    ).toStrictEqual([{ n: 1 }]);
    expect(worker.state()).toMatchObject({ appliedSeq: 7 });
    worker.close();
  });
});

describe("the snapshot door over HTTP", () => {
  const head = new Headers({
    etag: '"e1-7"',
    "content-length": "128",
    "x-centraid-seat-seq": "7",
    "x-centraid-seat-epoch": "e1",
    "x-centraid-schema-epoch": "2",
  });

  it("reads the three numbers off the headers", async () => {
    const seen: RequestInit[] = [];
    const door = httpSeatSnapshotTransport({
      url: "/snapshot",
      fetch: (_input, init) => {
        seen.push(init ?? {});
        return Promise.resolve(
          new Response(null, { status: 200, headers: head })
        );
      },
    });
    await expect(door.head()).resolves.toStrictEqual({
      etag: '"e1-7"',
      bytes: 128,
      seq: 7,
      epoch: "e1",
      schemaEpoch: 2,
    });
    expect(seen[0]?.method).toBe("HEAD");
  });

  it("pins the artifact with If-Range and refuses a 200 answering a resume", async () => {
    let requested: Headers | undefined;
    const door = httpSeatSnapshotTransport({
      url: "/snapshot",
      fetch: (_input, init) => {
        requested = new Headers(init?.headers);
        // The server answering 200 to a ranged request is `If-Range` saying
        // "different file" — never a partial answer to splice on.
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: head,
          })
        );
      },
    });
    const iterate = async (): Promise<void> => {
      for await (const _chunk of door.range(64, '"e1-7"')) void _chunk;
    };
    await expect(iterate()).rejects.toThrow(/moved/u);
    expect(requested?.get("if-range")).toBe('"e1-7"');
    expect(requested?.get("range")).toBe("bytes=64-");
  });

  it("refuses a response whose ETag is not the one being resumed", async () => {
    const door = httpSeatSnapshotTransport({
      url: "/snapshot",
      fetch: () =>
        Promise.resolve(
          new Response(new Uint8Array([1]), {
            status: 206,
            headers: new Headers({
              ...Object.fromEntries(head),
              etag: '"e1-9"',
            }),
          })
        ),
    });
    const iterate = async (): Promise<void> => {
      for await (const _chunk of door.range(64, '"e1-7"')) void _chunk;
    };
    await expect(iterate()).rejects.toThrow(/moved/u);
  });
});
