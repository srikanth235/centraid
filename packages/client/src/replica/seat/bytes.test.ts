import { describe, expect, it } from "vitest";

import {
  applySeatPurgeTombstone,
  createSeatBlobPresence,
  noteSeatBlobClaimed,
  noteSeatPurgeAcknowledged,
  pinSeatBlob,
  readSeatBlob,
  recordSeatBlob,
  seatEvictionCandidates,
  unacknowledgedSeatPurges,
  unclaimedSeatBlobs,
} from "./blob-presence.js";
import {
  seatByteEvictable,
  seatByteVerdict,
  SeatThumbIsARowError,
} from "./byte-policy.js";
import { openSeatFile } from "./driver.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { SeatBootstrapNoRoomError } from "./seat-bootstrap-no-room-error.js";
import {
  chooseSeatContents,
  reduceSeatToRowsMinusFts,
} from "./storage-probe.js";

function seat(): NodeSeatDriver {
  const driver = new NodeSeatDriver();
  openSeatFile(driver);
  createSeatBlobPresence(driver);
  return driver;
}

describe("the seat's byte policy (R7)", () => {
  it("refuses to answer about a thumb, which is a row every seat holds", () => {
    expect(() => seatByteVerdict("on-demand", { kind: "thumb" })).toThrow(
      SeatThumbIsARowError
    );
    expect(() => seatByteEvictable({ kind: "thumb" })).toThrow(
      SeatThumbIsARowError
    );
  });

  it("gives each seat the policy its hardware justifies", () => {
    expect(seatByteVerdict("everything", { kind: "original" })).toBe("hold");
    expect(seatByteVerdict("captured-and-cache", { kind: "preview" })).toBe(
      "cache"
    );
    expect(seatByteVerdict("captured-and-cache", { kind: "original" })).toBe(
      "on-demand"
    );
    expect(seatByteVerdict("on-demand", { kind: "preview" })).toBe("on-demand");
  });

  it("holds what this seat captured — it may be the only copy", () => {
    expect(
      seatByteVerdict("captured-and-cache", {
        kind: "original",
        capturedHere: true,
      })
    ).toBe("hold");
    expect(seatByteEvictable({ kind: "original", capturedHere: true })).toBe(
      false
    );
  });

  it("holds a pin and a capture a pending intent needs, whatever the policy", () => {
    expect(
      seatByteVerdict("on-demand", { kind: "original", pinned: true })
    ).toBe("hold");
    expect(
      seatByteVerdict("on-demand", {
        kind: "original",
        referencedByPendingIntent: true,
      })
    ).toBe("hold");
    // R25: the LRU cannot evict bytes the member's own queued work needs.
    expect(
      seatByteEvictable({ kind: "original", referencedByPendingIntent: true })
    ).toBe(false);
    expect(seatByteEvictable({ kind: "original" })).toBe(true);
  });
});

describe("blob presence and purge tombstones", () => {
  it("records what this seat holds and what it has told the gateway", () => {
    const driver = seat();
    recordSeatBlob(driver, {
      sha: "aa",
      kind: "original",
      byteSize: 1_000,
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(unclaimedSeatBlobs(driver).map((row) => row.sha)).toStrictEqual([
      "aa",
    ]);
    noteSeatBlobClaimed(driver, "aa", "intent-1");
    expect(unclaimedSeatBlobs(driver)).toStrictEqual([]);
    expect(readSeatBlob(driver, "aa")?.claimIntentId).toBe("intent-1");
    driver.close();
  });

  it("promotes on re-record but never erases an outstanding purge", () => {
    const driver = seat();
    recordSeatBlob(driver, { sha: "aa", kind: "preview", byteSize: 10 });
    applySeatPurgeTombstone(driver, "aa", 500);
    recordSeatBlob(driver, {
      sha: "aa",
      kind: "preview",
      byteSize: 10,
      pinned: true,
    });
    // Re-downloading condemned bytes is a bug to SEE, not a state to overwrite.
    expect(readSeatBlob(driver, "aa")?.purgeSeq).toBe(500);
    driver.close();
  });

  it("a purge is acknowledged by the seat, and the row says which purge", () => {
    const driver = seat();
    recordSeatBlob(driver, { sha: "aa", kind: "original", byteSize: 4_096 });
    recordSeatBlob(driver, { sha: "bb", kind: "original", byteSize: 4_096 });
    pinSeatBlob(driver, "aa", true);

    const condemned = applySeatPurgeTombstone(driver, "aa", 900);
    // The bytes the caller must now delete come back, because the seat's FILES
    // are not this table's to remove.
    expect(condemned?.byteSize).toBe(4_096);
    // A tombstone beats a pin: the gateway has decided the blob is gone.
    expect(readSeatBlob(driver, "aa")?.pinned).toBe(false);
    expect(
      unacknowledgedSeatPurges(driver).map((row) => [row.sha, row.purgeSeq])
    ).toStrictEqual([["aa", 900]]);

    noteSeatPurgeAcknowledged(driver, "aa", "ack-1");
    expect(unacknowledgedSeatPurges(driver)).toStrictEqual([]);
    const held = readSeatBlob(driver, "aa");
    // The ROW survives the acknowledgement: "I have forgotten about this blob"
    // and "I never had it" must not be the same answer to the gateway.
    expect(held?.purgeAckIntentId).toBe("ack-1");
    expect(held?.purgeSeq).toBe(900);
    // A tombstone for bytes this seat never had is not an error and not an ack.
    expect(applySeatPurgeTombstone(driver, "never-held", 901)).toBeUndefined();
    driver.close();
  });

  it("offers the LRU only what nothing is protecting", () => {
    const driver = seat();
    const at = (n: number): string =>
      new Date(Date.UTC(2026, 0, n)).toISOString();
    recordSeatBlob(driver, {
      sha: "old",
      kind: "preview",
      byteSize: 100,
      now: at(1),
    });
    recordSeatBlob(driver, {
      sha: "pinned",
      kind: "preview",
      byteSize: 100,
      now: at(2),
      pinned: true,
    });
    recordSeatBlob(driver, {
      sha: "mine",
      kind: "preview",
      byteSize: 100,
      now: at(3),
      capturedHere: true,
    });
    recordSeatBlob(driver, {
      sha: "needed",
      kind: "preview",
      byteSize: 100,
      now: at(4),
    });
    recordSeatBlob(driver, {
      sha: "newer",
      kind: "preview",
      byteSize: 100,
      now: at(5),
    });
    expect(
      seatEvictionCandidates(driver, 250, ["needed"]).map((row) => row.sha)
    ).toStrictEqual(["old", "newer"]);
    driver.close();
  });
});

describe("the storage-estimate probe (OQ-2)", () => {
  it("takes the whole vault when it fits", () => {
    const choice = chooseSeatContents({
      estimate: { quota: 2_000_000_000, usage: 0 },
      expandedBytes: 64_356_352,
    });
    expect(choice.contents).toBe("full");
    expect(choice.available).toBe(2_000_000_000);
  });

  it("drops the search index when the rows fit and the index does not", () => {
    const choice = chooseSeatContents({
      estimate: { quota: 100_000_000, usage: 25_000_000 },
      expandedBytes: 64_356_352,
      headroomBytes: 20_000_000,
    });
    expect(choice.contents).toBe("rows-minus-fts");
    expect(choice.expectedBytes).toBeLessThan(64_356_352);
    expect(choice.reason).toContain("search runs online");
  });

  it("refuses rather than inventing a third contents when even the rows do not fit", () => {
    expect(() =>
      chooseSeatContents({
        estimate: { quota: 20_000_000, usage: 0 },
        expandedBytes: 64_356_352,
      })
    ).toThrow(SeatBootstrapNoRoomError);
  });

  it("takes the whole vault when the browser will not report a quota", () => {
    const choice = chooseSeatContents({ expandedBytes: 64_356_352 });
    expect(choice.contents).toBe("full");
    expect(choice.available).toBeUndefined();
    expect(choice.reason).toContain("does not report a storage quota");
  });

  it("drops the index AND the triggers that write to it", () => {
    const driver = new NodeSeatDriver();
    openSeatFile(driver);
    driver.exec(`
      CREATE TABLE note (note_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
      CREATE VIRTUAL TABLE fts_note USING fts5(note_id UNINDEXED, title);
      CREATE TRIGGER note_fts_ai AFTER INSERT ON note BEGIN
        INSERT INTO fts_note (note_id, title) VALUES (new.note_id, new.title);
      END;
    `);
    const dropped = reduceSeatToRowsMinusFts(driver);
    expect(dropped.tables).toStrictEqual(["fts_note"]);
    expect(dropped.triggers).toStrictEqual(["note_fts_ai"]);
    // The point of dropping both: the file still takes a write. Leaving the
    // trigger behind fails here with `no such table: main.fts_note`.
    driver.run(`INSERT INTO note VALUES ('n1', 'after the reduction')`);
    expect(driver.all(`SELECT count(*) AS n FROM note`)).toStrictEqual([
      { n: 1 },
    ]);
    driver.close();
  });
});
