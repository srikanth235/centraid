/**
 * The CLIENT-SIDE TERM of reconnect-to-fresh, at year-3 phone volume. Method,
 * scope and ceiling: `tests/journeys.json`. The number is a
 * LOWER BOUND on what the owner feels — no network RTT, no device flash, no
 * render.
 *
 * It gates on WALL CLOCK, which is why it is here rather than in the mobile
 * package's own suite: `bun run test` drives 29 turbo tasks across four
 * threads, and under that contention this probe measured 3,292 ms against its
 * 1,800 ms ceiling while measuring 482 ms alone. The nightly scale lane runs
 * `fileParallelism: false` in a forked pool, which is the isolation a
 * wall-clock budget needs to mean anything. Its untimed sibling — a session
 * with no shape catalog must refuse rather than answer empty (#883 D1) — stays
 * in the ordinary suite next to the fixture both share.
 */

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { createNativeReplicaSession } from "../../apps/mobile/src/lib/replica/native-session";
import {
  createFeed,
  createGateway,
  gatewayAuth,
  json,
  noChanges,
  nodeDigest,
  sequentialIds,
} from "../../apps/mobile/src/lib/replica/native-session.test-fixtures";
import { NodeSqliteDriver } from "../../apps/mobile/src/lib/replica/node-sqlite-driver";
import {
  APP_ID,
  bootstrapPage,
  corpus,
  createAppState,
  ENTITY,
  MISSED_CHANGES,
  missedBatch,
  REPLICA_ROWS,
  RESUME_DEADLINE_MS,
  SCREEN_PAGE,
} from "../../apps/mobile/src/lib/replica/reconnect-to-fresh.fixture";
import { journeyCeiling } from "../helpers/journeys.js";

const OWNER = "tests/scale/mobile-reconnect-to-fresh.scale.test.ts";

describe("reconnect-to-fresh probe", () => {
  test(
    "a backgrounded native session resumes to a fresh screen inside the mobile ceiling",
    async () => {
      const ceilingMs = journeyCeiling(
        "mobile/converge/year3-replica/ci-linux-x64-4c",
        "reconnectToFresh",
        "ceilingMs"
      );

      const rows = corpus();
      const gateway = createGateway()
        .on("/replica/bootstrap", () => json(bootstrapPage(rows)))
        // The bootstrap's own convergence replay finds nothing.
        .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })));
      const feed = createFeed();
      const appState = createAppState();
      const session = await createNativeReplicaSession({
        gatewayAuth,
        fetcher: gateway.fetcher,
        changeFeed: feed,
        driver: new NodeSqliteDriver(),
        digest: nodeDigest,
        idFactory: sequentialIds(),
        appState,
      });
      try {
        expect((await session.status()).cursor).toStrictEqual({
          epoch: "replica-1",
          seq: 1,
        });
        const before = await session.read(APP_ID, {
          entity: ENTITY,
          orderBy: { column: "created_at", dir: "desc" },
          limit: SCREEN_PAGE,
        });
        expect(before.rows).toHaveLength(SCREEN_PAGE);
        expect(
          before.rows.some((row) =>
            String(row.values.title).startsWith("Renamed while away")
          ),
          "the pre-background screen must NOT already show the changes — otherwise the resume proves nothing"
        ).toBe(false);

        appState.send("background");
        expect(feed.active).toBe(false);

        // Queued now; served on the resume pull.
        gateway
          .on("/changes", () => json(missedBatch()))
          .on("/changes", () =>
            json(noChanges({ epoch: "replica-1", seq: 2 }))
          );

        // The first instant the phone could know it is back.
        const started = performance.now();
        appState.send("active");
        expect(feed.active).toBe(true);

        // Stop on the SCREEN'S read, not the delta: resume is asynchronous,
        // so polling is the only honest observer.
        let freshMs = Number.NaN;
        let framesPolled = 0;
        for (;;) {
          framesPolled += 1;
          // Sequential by necessity: each poll observes what the last left.
          // oxlint-disable-next-line no-await-in-loop
          const page = await session.read(APP_ID, {
            entity: ENTITY,
            orderBy: { column: "created_at", dir: "desc" },
            limit: SCREEN_PAGE,
          });
          const renamed = page.rows.filter((row) =>
            String(row.values.title).startsWith("Renamed while away")
          ).length;
          if (renamed === MISSED_CHANGES) {
            freshMs = performance.now() - started;
            break;
          }
          if (performance.now() - started > RESUME_DEADLINE_MS) {
            throw new Error(
              `resume did not reach a fresh screen within ${RESUME_DEADLINE_MS} ms ` +
                `(saw ${renamed}/${MISSED_CHANGES} changed rows on the page)`
            );
          }
        }

        expect((await session.status()).cursor).toStrictEqual({
          epoch: "replica-1",
          seq: 2,
        });
        console.log(
          `\nmobile reconnectToFresh: ${freshMs.toFixed(1)} ms ` +
            `(${REPLICA_ROWS} replica rows, ${MISSED_CHANGES} missed changes, ` +
            `${SCREEN_PAGE}-row screen page, ${framesPolled} polls) ` +
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
            { name: "polls to fresh", value: framesPolled, unit: "count" },
          ],
        });
        expect(freshMs).toBeLessThan(ceilingMs);
      } finally {
        await session.close();
      }
    },
    RESUME_DEADLINE_MS + 120_000
  );
});
