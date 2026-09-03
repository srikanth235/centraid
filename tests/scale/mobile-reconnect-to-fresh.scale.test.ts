import { promises as fs } from "node:fs";
import path from "node:path";

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
import type { CeilingFile } from "../../apps/mobile/src/lib/replica/reconnect-to-fresh.fixture";
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
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/mobile-reconnect-to-fresh.scale.test.ts";

describe("reconnect-to-fresh probe", () => {
  test(
    "a backgrounded native session resumes to a fresh screen inside the mobile ceiling",
    async () => {
      const ceilings = JSON.parse(
        await fs.readFile(
          path.resolve(
            import.meta.dirname,
            "../experience-budgets/mobile.json"
          ),
          "utf8"
        )
      ) as CeilingFile;
      const ceilingMs = ceilings.metrics.reconnectToFresh.ceilingMs;
      expect(
        ceilingMs,
        "tests/experience-budgets/mobile.json#reconnectToFresh must carry a ceilingMs for this probe to gate on"
      ).toBeTypeOf("number");

      const rows = corpus();
      const gateway = createGateway()
        .on("/replica/bootstrap", () => json(bootstrapPage(rows)))
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

        gateway
          .on("/changes", () => json(missedBatch()))
          .on("/changes", () =>
            json(noChanges({ epoch: "replica-1", seq: 2 }))
          );

        const started = performance.now();
        appState.send("active");
        expect(feed.active).toBe(true);

        let freshMs = Number.NaN;
        let framesPolled = 0;
        for (;;) {
          framesPolled += 1;
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
        const drift = await rigDriftBudgetMs("scale", OWNER);
        const withinDrift = drift === null || freshMs <= drift;
        await recordQualityResult({
          lane: "scale",
          owner: OWNER,
          name: `Mobile reconnect to fresh at ${REPLICA_ROWS} rows`,
          status: withinDrift && freshMs < ceilingMs! ? "passed" : "failed",
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
        expect(
          withinDrift,
          `sustained drift: ${freshMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
        ).toBe(true);
        expect(freshMs).toBeLessThan(ceilingMs!);
      } finally {
        await session.close();
      }
    },
    RESUME_DEADLINE_MS + 120_000
  );
});
