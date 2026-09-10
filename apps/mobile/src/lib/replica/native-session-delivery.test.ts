/*
 * WHAT MAKES A GATEWAY WRITE REACH THIS PHONE (#1014, R15/R22/C3/C4).
 *
 * The live trace: two foregrounded simulators, a reachable gateway, and a row
 * committed on one of them reached neither. `lsof` on the gateway showed zero
 * established connections from either device, and the gateway served no seat
 * log page for five minutes. The only working delivery trigger in the product
 * was a background→foreground transition.
 *
 * Three things are pinned here, and each of them is a delivery trigger the
 * product did not have:
 *
 *   1. A CLOCK. The wake feed is an optimisation and it is allowed to die; a
 *      foregrounded session catches up on an interval regardless.
 *   2. THE LATCH RESETS. One rebootstrap frame muted that vault's feed for the
 *      life of the process, because `resume()` — the only reset — had no
 *      production caller anywhere.
 *   3. ROWS LANDING SAY SO. The applier's change sink was wired on the browser
 *      and on nothing else, so a page landed in the phone's file and no screen
 *      re-read it.
 */

import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  ReplicaCursor,
  ReplicaInvalidation,
  SeatWatermark,
  SeatWorkerSink,
} from "@centraid/client/replica/native";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openNodeNativeSeat } from "./native-seat.test-fixtures";
import type { NativeChangeFeed, NativeReplicaSession } from "./native-session";
import { createNativeReplicaSession } from "./native-session-open";

const gatewayAuth = {
  baseUrl: "http://127.0.0.1:18789",
  gatewayId: "gateway-1",
  vaultId: "vault-a",
};

const WATERMARK: SeatWatermark = {
  epoch: "epoch-a",
  applied: 12,
  appliedCommitSeq: 3,
  head: 12,
  behind: 0,
  deferredPending: false,
  contents: "full",
};

interface RecordingFeed extends NativeChangeFeed {
  resumed: ReplicaCursor[];
}

function recordingFeed(): RecordingFeed {
  const resumed: ReplicaCursor[] = [];
  return {
    resumed,
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: (cursor: ReplicaCursor) => {
      resumed.push(cursor);
      return Promise.resolve();
    },
    setActive: () => undefined,
  };
}

const open: NativeReplicaSession[] = [];

/** Poll rather than sleep a fixed span: these rails ride timers and jitter. */
async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by definition
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  return predicate();
}

async function rig(options: {
  file: string;
  feed: NativeChangeFeed;
  pullIntervalMs?: number;
  watermark?: SeatWatermark;
}): Promise<{
  session: NativeReplicaSession;
  pulls: () => number;
  sink: () => SeatWorkerSink | undefined;
  invalidations: ReplicaInvalidation[];
  applied: number[];
}> {
  let pulls = 0;
  let sink: SeatWorkerSink | undefined;
  const seat = await openNodeNativeSeat({
    path: options.file,
    syncOutcome: () => {
      pulls += 1;
      return Promise.resolve(options.watermark);
    },
  });
  const applied: number[] = [];
  const session = await createNativeReplicaSession({
    gatewayAuth: { ...gatewayAuth },
    seat: {
      ...seat,
      watermark: () => options.watermark,
      attachSink: (attached: SeatWorkerSink) => {
        sink = attached;
        seat.attachSink(attached);
      },
    },
    changeFeed: options.feed,
    isConnected: () => true,
    digest: (canonical: string) =>
      Promise.resolve(`digest:${canonical.length}`),
    idFactory: () => "intent-1",
    retryDelayMs: 10_000,
    ...(options.pullIntervalMs === undefined
      ? {}
      : { pullIntervalMs: options.pullIntervalMs }),
    onApplied: (at: number) => applied.push(at),
    fetcher: () =>
      Promise.resolve(
        new Response("{}", { headers: { "content-type": "application/json" } })
      ),
  });
  open.push(session);
  const invalidations: ReplicaInvalidation[] = [];
  session.subscribe("app", (batch) => invalidations.push(...batch));
  return {
    session,
    pulls: () => pulls,
    sink: () => sink,
    invalidations,
    applied,
  };
}

describe("what delivers a gateway write to a foregrounded phone", () => {
  afterEach(async () => {
    await forEachSequentially(open.splice(0), (session) => session.close());
  });

  test("a foregrounded session catches up on a clock, with no feed at all", async () => {
    const file = path.join(tempDirSync("centraid-delivery-"), "seat.sqlite3");
    const rigged = await rig({
      file,
      feed: recordingFeed(),
      pullIntervalMs: 15,
      watermark: WATERMARK,
    });
    // `start()` fires one; the clock is what produces the rest, and nothing
    // here foregrounds, reconnects or writes.
    await expect(
      until(() => rigged.pulls() >= 3),
      "a foregrounded session must not depend on the feed to pull"
    ).resolves.toBe(true);
  });

  test("a re-bootstrap resumes the feed, so one frame cannot mute it forever", async () => {
    const file = path.join(tempDirSync("centraid-delivery-"), "seat.sqlite3");
    const feed = recordingFeed();
    const rigged = await rig({
      file,
      feed,
      pullIntervalMs: 60_000,
      watermark: WATERMARK,
    });
    rigged.session.requireBootstrap({ reason: "retention" });
    await expect(until(() => feed.resumed.length > 0)).resolves.toBe(true);
    expect(feed.resumed.at(-1)).toStrictEqual({
      epoch: WATERMARK.epoch,
      seq: WATERMARK.applied,
    });
  });

  test("rows landing in the file invalidate the entities they touched", async () => {
    const file = path.join(tempDirSync("centraid-delivery-"), "seat.sqlite3");
    const rigged = await rig({
      file,
      feed: recordingFeed(),
      pullIntervalMs: 60_000,
    });
    const sink = rigged.sink();
    expect(
      sink,
      "the session wires the applier's sink on this host too"
    ).toBeDefined();
    sink?.onChange?.({
      tables: ["knowledge_note", "seat_state"],
      cursor: 41,
      commitSeqs: [7],
    });
    expect(rigged.invalidations).toStrictEqual([
      { entity: "knowledge.note", source: "canonical" },
    ]);
    // The freshness stamp is the position the FILE reached, not the frame's.
    expect(rigged.applied).toStrictEqual([41]);
  });
});
