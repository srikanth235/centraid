/*
 * KILLED MID-SWAP, WITH SOMETHING QUEUED (#1014, C5/T6).
 *
 * A re-bootstrap replaces the seat's file with a copy of the gateway's. That
 * is right for every row in it and CATASTROPHIC for the one thing that exists
 * nowhere else: the member's queued intents. `rebootstrap-copy.ts` tells them
 * "your unsent changes stay queued" while it runs.
 *
 * THE SWAP HAS NO ATOMIC STEP. The queue comes out of the old file, the handle
 * is released, an artifact arrives over minutes on a phone's connection, the
 * file is REPLACED — on native by `removeQuietly(destination)` followed by
 * `moveSync(incoming)`, so the old file is gone before the new one is named —
 * and only then is the queue written back. A kill at any of those boundaries
 * used to lose work, because the queue was held in a JS heap object across all
 * of it.
 *
 * So this suite kills the process at each boundary and asks the only question
 * that matters afterwards: is the member's intent still there, with its
 * payload, and does it still drain — once. It is a FAULT LANE rather than a
 * unit test because the seams are the HOST's (staging, the driver, the
 * sidecar) and only this tier holds all three against a real gateway.
 *
 * `carry-over.test.ts` owns the same claim at the unit tier; what this adds is
 * a real snapshot artifact, a real log door, and a real drain afterwards.
 */

import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { NodeSeatDriver } from "../../packages/client/src/replica/seat/node-seat-driver.js";
import { readSeatOutbox } from "../../packages/client/src/replica/seat/outbox.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openNodeSeat } from "./lib/node-seat.js";
import { readEntity } from "./lib/reads.js";
import { drain, openSeat } from "./lib/seat.js";

/** What a phone killed at that instant leaves behind, without killing vitest. */
class KilledError extends Error {
  override readonly name = "KilledError";
}

const FILE = "faults-seat.sqlite3";
const TITLE = "Queued before the swap";

describe("a seat killed part-way through a re-bootstrap", () => {
  let gateway: MobileGateway;
  let storage: string;
  let seatFile: string;
  let template: string;

  /** Restore the "one intent queued, no `seat_state`" file every case starts from. */
  function restoreQueuedFile(): void {
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(`${seatFile}${suffix}`, { force: true });
    rmSync(`${seatFile}.carry-over.json`, { force: true });
    rmSync(`${seatFile}-staging`, { force: true, recursive: true });
    copyFileSync(template, seatFile);
  }

  /**
   * Sync until the injected kill lands, treating a moved snapshot as the retry
   * it is on the phone.
   *
   * A gateway does its own work — the scheduler's reconcile, the bundled
   * automations — so its snapshot ETag really can move between the seat's HEAD
   * and its ranged GET. `bootstrapSeatFile` refuses that rather than splicing
   * two artifacts (which is correct), and the phone asks again. A suite that
   * did not would be asserting the absence of background work.
   */
  /* oxlint-disable no-await-in-loop -- a retry is sequential by definition:
     the next attempt exists only because the previous one was refused */
  async function killedBootstrap(seat: {
    sync: () => Promise<unknown>;
  }): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const thrown = await seat.sync().then(
        () => undefined,
        (error: unknown) => error
      );
      if (thrown === undefined) throw new Error("the bootstrap was not killed");
      if ((thrown as { code?: string }).code !== "seat_snapshot_moved")
        return thrown;
    }
    throw new Error("the snapshot moved on every attempt");
  }
  /* oxlint-enable no-await-in-loop */

  function queuedIntents(): ReturnType<typeof readSeatOutbox> {
    const driver = new NodeSeatDriver(seatFile);
    try {
      return readSeatOutbox(driver);
    } finally {
      driver.close();
    }
  }

  beforeAll(async () => {
    gateway = await bootMobileGateway("seat-swap-faults");
    storage = path.join(gateway.dataDir, "faults");
    seatFile = path.join(storage, FILE);
    template = path.join(gateway.dataDir, "faults-template.sqlite3");

    // One real queued write, made with the transport cut, through the shipped
    // session — not an outbox row written by hand.
    const seat = await openSeat(gateway, {
      label: "faults",
      directory: storage,
      fileName: FILE,
    });
    seat.cut();
    await seat.session.write("docs", {
      action: "upload",
      input: { data_uri: "data:text/plain;base64,cXVldWVk", title: TITLE },
    });
    seat.restore();
    await seat.close();

    // A file with no `seat_state` is one the seat reads as "I have no copy",
    // which is what makes the next open a BOOTSTRAP — R25's forensic shape,
    // reused here as the arrangement. Its `seat_outbox` is untouched.
    const scrub = new NodeSeatDriver(seatFile);
    scrub.exec("DROP TABLE IF EXISTS seat_state");
    // FOLDED INTO THE MAIN FILE BEFORE THE JOURNAL IS DROPPED. The seat opens
    // WAL, so removing `-wal` without checkpointing throws away the drop AND
    // half of whatever else was still in it — the copy below would be a file
    // SQLite refuses to read at all.
    scrub.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    scrub.close();
    for (const suffix of ["-wal", "-shm"])
      rmSync(`${seatFile}${suffix}`, { force: true });
    copyFileSync(seatFile, template);
    // The arrangement itself, proved rather than assumed: every case below
    // starts from a file with exactly one queued intent and no `seat_state`.
    if (queuedIntents().length !== 1)
      throw new Error("the arrangement did not queue exactly one intent");
  }, 120_000);

  afterAll(async () => {
    await gateway?.close();
  });

  /*
   * Each row is a boundary in the swap, named for what the phone was doing.
   * `after-install` is T6 itself: on native the destination is already gone at
   * that instant, so the sidecar is the ONLY copy of the queue in the world.
   */
  /**
   * The stash seam is asked twice per open — once on `open()`, which replays a
   * sidecar left by a previous kill, and once by the bootstrap. Only the second
   * is the swap, so the first is let through.
   */
  function onSecondCall(): () => void {
    let calls = 0;
    return () => {
      calls += 1;
      if (calls > 1) throw new KilledError("killed before the stash");
    };
  }

  const boundaries = [
    {
      name: "before the queue is stashed",
      faults: { carryOver: onSecondCall() },
    },
    {
      name: "after the handle is released, before the download",
      faults: {
        staging: (): never => {
          throw new KilledError("killed before the download");
        },
      },
    },
    {
      name: "after the download, before the install",
      faults: {
        install: (): Promise<void> => {
          throw new KilledError("killed before the install");
        },
      },
    },
    {
      name: "after the install, before the write-back",
      faults: {
        install: async (run: () => Promise<void>): Promise<void> => {
          await run();
          throw new KilledError("killed after the install");
        },
      },
    },
  ] as const;

  test.each(boundaries)(
    "keeps the queued intent when the phone dies $name",
    async ({ faults }) => {
      restoreQueuedFile();

      const dying = await openNodeSeat({
        directory: storage,
        fileName: FILE,
        vaultId: gateway.vaultId,
        baseUrl: gateway.url,
        headers: {
          Authorization: `Bearer ${gateway.token}`,
          "x-centraid-vault": gateway.vaultId,
        },
        faults,
      });
      await expect(killedBootstrap(dying)).resolves.toBeInstanceOf(KilledError);
      await dying.close();

      // THE ONLY QUESTION. Reopen the FILE — no session, so nothing drains
      // behind the assertion — and finish the swap the kill interrupted.
      const recovered = await openNodeSeat({
        directory: storage,
        fileName: FILE,
        vaultId: gateway.vaultId,
        baseUrl: gateway.url,
        headers: {
          Authorization: `Bearer ${gateway.token}`,
          "x-centraid-vault": gateway.vaultId,
        },
      });
      try {
        await recovered.sync();
        const held = queuedIntents();
        expect(held).toHaveLength(1);
        // WITH ITS PAYLOAD. An intent whose input did not survive is a row
        // that cannot be sent, which is the same loss with a badge on it.
        const survivor = held[0]!;
        expect((survivor.input as { title?: string }).title).toBe(TITLE);
        expect(survivor.action).toBe("upload");
      } finally {
        await recovered.close();
      }
    },
    180_000
  );

  test("and the recovered intent still drains, once", async () => {
    restoreQueuedFile();
    // The T6 boundary again — the one where the sidecar is the queue's only
    // copy in the world — because surviving is only half of it: a queue that
    // comes back and then doubles is the other way this repair could cost
    // the member.
    const dying = await openNodeSeat({
      directory: storage,
      fileName: FILE,
      vaultId: gateway.vaultId,
      baseUrl: gateway.url,
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        "x-centraid-vault": gateway.vaultId,
      },
      faults: {
        install: async (run) => {
          await run();
          throw new KilledError("killed after the install");
        },
      },
    });
    await expect(killedBootstrap(dying)).resolves.toBeInstanceOf(KilledError);
    await dying.close();

    const recovered = await openSeat(gateway, {
      label: "faults-drained",
      directory: storage,
      fileName: FILE,
    });
    try {
      await drain(recovered);
      await recovered.session.pullNow();
      const docs = await readEntity(recovered, "core.document");
      expect(
        docs.rows.filter((row) => row["title"] === TITLE),
        "the queued upload landed a different number of times than once"
      ).toHaveLength(1);
    } finally {
      await recovered.close();
    }
  }, 180_000);
});
