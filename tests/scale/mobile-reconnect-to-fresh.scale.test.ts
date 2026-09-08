/**
 * The CLIENT-SIDE TERM of reconnect-to-fresh, at year-3 phone volume. Method,
 * scope and ceiling: `tests/journeys.json`. The number is a LOWER BOUND on what
 * the owner feels — no network RTT, no device flash, no render.
 *
 * WHAT IT MEASURES SINCE #996 W5. The phone comes back from the background
 * behind by the commits it missed, and what it does about that is APPLY A LOG
 * PAGE to its own copy of the vault and then re-run the screen's page. So the
 * clock spans exactly those two: the real applier over a real file at 50,000
 * rows, and the real keyset page a screen asks for. There is no shaped
 * bootstrap and no change batch left to time.
 *
 * It gates on WALL CLOCK, which is why it is here rather than in the mobile
 * package's own suite: `bun run test` drives turbo tasks across four threads,
 * and under that contention this probe measured 3,292 ms against its 1,800 ms
 * ceiling while measuring 482 ms alone. The nightly scale lane runs
 * `fileParallelism: false` in a forked pool, which is the isolation a
 * wall-clock budget needs to mean anything.
 */

import path from "node:path";

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  CORPUS_DDL,
  contentId,
  corpus,
  EPOCH,
  MISSED_CHANGES,
  missedLogPage,
  REPLICA_ROWS,
  SCHEMA_EPOCH,
  SCREEN_PAGE,
  TABLE,
} from "../../apps/mobile/src/lib/replica/reconnect-to-fresh.fixture";
import { applySeatLogPage } from "../../packages/client/src/replica/seat/applier.js";
import { NodeSeatDriver } from "../../packages/client/src/replica/seat/node-seat-driver.js";
import { seatWorkerPage } from "../../packages/client/src/replica/seat/seat-page-reader.js";
import type { SeatQueryPort } from "../../packages/client/src/replica/seat/seat-page-reader.js";
import { initSeatState } from "../../packages/client/src/replica/seat/state.js";
import type { SeatWorkerQuery } from "../../packages/client/src/replica/seat/worker-protocol.js";
import { journeyCeiling } from "../helpers/journeys.js";

const OWNER = "tests/scale/mobile-reconnect-to-fresh.scale.test.ts";

interface ScreenRow {
  content_id: string;
  title: string;
  created_at: string;
}

/** The screen's own statement: newest first, keyset-paged on its two columns. */
const SCREEN_QUERY = {
  name: "photos.library",
  select: "content_id, title, created_at",
  from: `"${TABLE}"`,
  where: "deleted_at IS NULL",
  order: {
    sortColumn: "created_at",
    pkColumn: "content_id",
    descending: true,
  },
} as const;

describe("reconnect-to-fresh probe", () => {
  test("a backgrounded phone applies what it missed and repaints inside the mobile ceiling", async () => {
    const ceilingMs = journeyCeiling(
      "mobile/converge/year3-replica/ci-linux-x64-4c",
      "reconnectToFresh",
      "ceilingMs"
    );

    const root = tempDirSync("centraid-reconnect-");
    const driver = new NodeSeatDriver(path.join(root, "seat.db"));
    try {
      driver.exec(CORPUS_DDL);
      // The corpus goes in as ROWS OF THE VAULT'S OWN TABLE, in one
      // transaction, because that is what a bootstrapped seat holds — the
      // snapshot install is `seat-replay-parity`'s claim, not this one's.
      driver.exec("BEGIN");
      for (const row of corpus()) {
        driver.run(
          `INSERT INTO ${TABLE}
               (content_id, title, deleted_at, created_at)
             VALUES (?, ?, NULL, ?)`,
          [row.content_id, row.title, row.created_at]
        );
      }
      driver.exec("COMMIT");
      initSeatState(driver, {
        vaultId: "vault-a",
        epoch: EPOCH,
        schemaEpoch: SCHEMA_EPOCH,
        appliedSeq: 1,
        contents: "full",
      });

      // The driver IS the port: a page is a statement, and a suite with no
      // worker boundary runs it directly on the file.
      const port: SeatQueryPort = {
        query: <T extends object>(request: SeatWorkerQuery): Promise<T[]> =>
          Promise.resolve(driver.all<T>(request.sql, request.bind ?? [])),
      };
      const before = await seatWorkerPage<ScreenRow>(port, SCREEN_QUERY, {
        limit: SCREEN_PAGE,
      });
      expect(before.rows).toHaveLength(SCREEN_PAGE);
      expect(
        before.rows.some((row) =>
          String(row.title).startsWith("Renamed while away")
        ),
        "the pre-background screen must NOT already show the changes — otherwise the resume proves nothing"
      ).toBe(false);

      // The first instant the phone could know it is back.
      const started = performance.now();
      applySeatLogPage(driver, missedLogPage(1));
      const page = await seatWorkerPage<ScreenRow>(port, SCREEN_QUERY, {
        limit: SCREEN_PAGE,
      });
      const freshMs = performance.now() - started;

      const renamed = page.rows.filter((row) =>
        String(row.title).startsWith("Renamed while away")
      ).length;
      expect(renamed).toBe(MISSED_CHANGES);
      // The applier wrote the row it was sent, not a row it composed.
      expect(
        page.rows.find((row) => row.content_id === contentId(0))?.title
      ).toBe("Renamed while away 0");

      console.log(
        `\nmobile reconnectToFresh: ${freshMs.toFixed(1)} ms ` +
          `(${REPLICA_ROWS} seat rows, ${MISSED_CHANGES} missed commits, ` +
          `${SCREEN_PAGE}-row screen page) ` +
          "— client-side term only; no network RTT, no device flash, no render\n"
      );
      await recordQualityResult({
        lane: "scale",
        owner: OWNER,
        name: `Mobile reconnect to fresh at ${REPLICA_ROWS} rows`,
        status: freshMs < ceilingMs ? "passed" : "failed",
        measurements: [
          {
            name: "reconnect to fresh",
            value: freshMs,
            unit: "ms",
            budget: ceilingMs,
          },
        ],
      });
      expect(freshMs).toBeLessThan(ceilingMs);
    } finally {
      driver.close();
    }
  }, 240_000);
});
