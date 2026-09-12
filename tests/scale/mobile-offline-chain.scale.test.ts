/**
 * THE FOUR INTERVALS OF AN OFFLINE CHAIN, ON THE PRODUCTION SESSION
 * (#996 R23–R25). Method, scope and ceilings: `tests/journeys.json`.
 *
 * One arc, four clocks, in the order the member lives them:
 *
 *   durable-save     the tap to "saved on this phone" — the answer `write()`
 *                    gives with no radio.
 *   pending-render   the outbox to the rows and badges the screen draws for
 *                    it, including the held-dependent copy.
 *   restart-recovery the app is killed and relaunched, still offline: the same
 *                    file reopened to the same five pending rows.
 *   reconnect-drain  the radio returns to an empty outbox, executed in order.
 *
 * EVERY NUMBER HERE IS A LOWER BOUND on what the owner feels, and the ledger
 * says so: the gateway is an in-process fetch double (no RTT), `node:sqlite`
 * on a container filesystem stands in for the phone's flash, and nothing
 * renders. What it does measure honestly is the seat's own work — the outbox
 * writes, the chain derivation, the projection rebuild and the drain — which
 * is the half this repo owns. The phone's own numbers are separate rows,
 * device-pending on `mobile-device-gate`.
 *
 * It gates on WALL CLOCK, so it belongs to the scale lane's `fileParallelism:
 * false` forked pool for the same reason `mobile-reconnect-to-fresh` does.
 */

import path from "node:path";

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openNodeNativeSeat } from "../../apps/mobile/src/lib/replica/native-seat.test-fixtures";
import type { NativeChangeFeed } from "../../apps/mobile/src/lib/replica/native-session";
import { createNativeReplicaSession } from "../../apps/mobile/src/lib/replica/native-session-open";
import { journeyCeiling } from "../helpers/journeys.js";

const OWNER = "tests/scale/mobile-offline-chain.scale.test.ts";

const gatewayAuth = {
  baseUrl: "http://127.0.0.1:18789",
  gatewayId: "gateway-1",
  vaultId: "vault-a",
};

/** The tables this chain's projections draw over, in the seat's own file. */
const VAULT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS media_asset (
    asset_id TEXT PRIMARY KEY, caption TEXT,
    row_version INTEGER NOT NULL DEFAULT 1
  ) STRICT;
`;

function createFeed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}

const nodeDigest = (canonical: string): Promise<string> =>
  Promise.resolve(`digest:${canonical.length}`);

function sequentialIds(): () => string {
  let n = 0;
  return () => `intent-${(n += 1)}`;
}
/** The acceptance row's five: create, rename twice, due date, complete. */
const CHAIN = [
  { action: "photos.add_caption", input: { caption: "Book the ferry" } },
  { action: "photos.add_caption", input: { caption: "Book the ferry (Tue)" } },
  { action: "photos.add_caption", input: { caption: "Ferry tickets" } },
  { action: "photos.favorite", input: { favorite: true } },
  { action: "photos.favorite", input: { favorite: false } },
] as const;

function ceiling(journey: string, metric: string): number {
  return journeyCeiling(
    `mobile/${journey}/none/ci-linux-x64-4c`,
    metric,
    "ceilingMs"
  );
}

describe("the offline chain's four intervals", () => {
  test("save, draw, relaunch and drain stay inside the seat's own ceilings", async () => {
    const file = path.join(tempDirSync("centraid-chain-"), "replica.db");
    // A gateway that ANSWERS THE INTENT IT WAS SENT: a canned outcome id
    // would leave every intent unmatched and time a drain that drained
    // nothing.
    const fetcher = (
      _baseUrl: string,
      pathname: string,
      init: RequestInit
    ): Promise<Response> => {
      if (pathname.includes("/replica/intents")) {
        const sent = JSON.parse(String(init.body)) as { intentId: string };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              outcome: {
                intentId: sent.intentId,
                status: "executed",
                commitSeq: 1,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    let online = true;
    // THE SAME FILE TWICE IS THE SAME SEAT. That is what makes the restart
    // interval below a restart: the second session reopens the outbox the
    // first one committed to, rather than starting an empty one.
    const open = async () =>
      createNativeReplicaSession({
        gatewayAuth,
        fetcher,
        changeFeed: createFeed(),
        seat: await openNodeNativeSeat({ path: file, schema: VAULT_SCHEMA }),
        digest: nodeDigest,
        idFactory: sequentialIds(),
        isConnected: () => online,
      });

    let session = await open();
    online = false;

    const savedMs: number[] = [];
    for (const write of CHAIN) {
      const started = performance.now();
      // Sequential BY CONSTRUCTION: the chain's order is its subject, and
      // each write observes what the last one left in the outbox.
      // oxlint-disable-next-line no-await-in-loop
      const result = await session.write("photos", write);
      savedMs.push(performance.now() - started);
      expect(result.status).toBe("queued");
    }
    const durableSaveMs = Math.max(...savedMs);

    const renderStarted = performance.now();
    const pending = await session.pendingChanges();
    const pendingRenderMs = performance.now() - renderStarted;
    expect(pending).toHaveLength(CHAIN.length);

    // Killed and relaunched, still offline: a new seat over the SAME file is
    // what a process restart is.
    await session.close();
    const restartStarted = performance.now();
    session = await open();
    const recovered = await session.pendingChanges();
    const restartRecoveryMs = performance.now() - restartStarted;
    expect(recovered).toHaveLength(CHAIN.length);
    expect(recovered.map((change) => change.intentId)).toStrictEqual(
      pending.map((change) => change.intentId)
    );

    // The radio returns. `flushIntents` drains from the outbox in order.
    //
    // THE CLOCK STOPS AT ACKNOWLEDGEMENT, not at a cleared overlay: an
    // executed intent waits for the applied cursor to reach its `commit_seq`
    // before its pending row goes (R24), and that interval is
    // `mobile/converge`'s, measured against a real delta. What this number
    // owns is the seat's own drain — claim, post, settle, in outbox order.
    online = true;
    const drainStarted = performance.now();
    await session.flushIntents();
    const reconnectDrainMs = performance.now() - drainStarted;
    const left = (await session.pendingChanges()).filter(
      (change) => change.status === "queued" || change.status === "sending"
    );
    expect(left).toStrictEqual([]);

    // stderr, not `console.log`: the scale lane's forked pool swallows a
    // captured console, and a probe whose numbers are invisible is a probe
    // nobody can check.
    process.stderr.write(
      `\nmobile offline chain: durable-save ${durableSaveMs.toFixed(1)} ms, ` +
        `pending-render ${pendingRenderMs.toFixed(1)} ms, ` +
        `restart-recovery ${restartRecoveryMs.toFixed(1)} ms, ` +
        `reconnect-drain ${reconnectDrainMs.toFixed(1)} ms ` +
        `(${CHAIN.length} chained intents, ${left.length} left unsent) ` +
        "— seat-side terms only; no network RTT, no device flash, no render\n"
    );

    const measured = [
      ["durable-save", "durableSave", durableSaveMs],
      ["pending-render", "pendingRender", pendingRenderMs],
      ["restart-recovery", "restartRecovery", restartRecoveryMs],
      ["reconnect-drain", "reconnectDrain", reconnectDrainMs],
    ] as const;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `Mobile offline chain of ${CHAIN.length} intents`,
      status: measured.every(
        ([journey, metric, value]) => value < ceiling(journey, metric)
      )
        ? "passed"
        : "failed",
      measurements: measured.map(([journey, metric, value]) => ({
        name: journey,
        value,
        unit: "ms",
        budget: ceiling(journey, metric),
      })),
    });
    for (const [journey, metric, value] of measured)
      expect(value).toBeLessThan(ceiling(journey, metric));

    await session.close();
  }, 60_000);
});
