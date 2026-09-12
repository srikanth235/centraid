// THE CATCH-UP RAIL, AND THE TWO WAYS IT WENT SILENT (#1011).
//
// A phone paired to a live gateway sat at its bootstrap watermark for hours
// while the vault took 453 log rows. Nothing was broken in the doors, the
// applier or the transport — the real page applies against the real file — and
// nothing anywhere said why. Two defects made that possible, and both are
// pinned here:
//
//   1. THE ORACLE WAS SET FROM THE PULL IT GATES. `ReplicaProvider` derived
//      `isConnected` from whether the last pull LANDED, and `catchUp` refuses
//      to run when `isConnected` is false — and refused WITHOUT scheduling
//      anything. One transient failure therefore latched the session shut for
//      the life of the mount: no retry, no request, an empty library drawn over
//      a full vault.
//
//   2. THE REASON WAS DROPPED. `SeatSyncLoop` swallows the outage by design,
//      so the session reported a boolean and the provider printed
//      `blocked=false` — which names the one thing that was not the cause.
//
// Both suites drive the SHIPPED session over the shipped seat port; only the
// catch-up's answer is posed, because that is the input under test.

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SeatWatermark } from "@centraid/client/replica/native";
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

function silentFeed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}

const WATERMARK: SeatWatermark = {
  epoch: "epoch-a",
  applied: 12,
  appliedCommitSeq: 12,
  head: 12,
  behind: 0,
  deferredPending: false,
  contents: "full",
};

const open: NativeReplicaSession[] = [];

interface CatchUpRig {
  session: NativeReplicaSession;
  /** How many catch-ups actually reached the seat's loop. */
  attempts: () => number;
}

async function rig(options: {
  file: string;
  connected: () => boolean;
  outcome: () => Promise<SeatWatermark | undefined>;
}): Promise<CatchUpRig> {
  let attempts = 0;
  const seat = await openNodeNativeSeat({
    path: options.file,
    syncOutcome: async () => {
      attempts += 1;
      return options.outcome();
    },
  });
  const session = await createNativeReplicaSession({
    gatewayAuth: { ...gatewayAuth },
    seat,
    changeFeed: silentFeed(),
    isConnected: options.connected,
    digest: (canonical: string) =>
      Promise.resolve(`digest:${canonical.length}`),
    idFactory: () => "intent-1",
    retryDelayMs: 10,
    fetcher: () =>
      Promise.resolve(
        new Response("{}", { headers: { "content-type": "application/json" } })
      ),
  });
  open.push(session);
  return { session, attempts: () => attempts };
}

/** Poll rather than sleep a fixed span: the retry rides a jittered backoff. */
async function until(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by definition
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  return predicate();
}

describe("a seat's catch-up when the phone believes it is offline", () => {
  afterEach(async () => {
    await forEachSequentially(open.splice(0), (session) =>
      session.close().catch(() => undefined)
    );
  });

  it("asks again once the oracle comes back, with no outside event", async () => {
    const root = tempDirSync("native-session-catchup-");
    let connected = false;
    const rigged = await rig({
      file: path.join(root, "seat.db"),
      connected: () => connected,
      outcome: () => Promise.resolve(WATERMARK),
    });
    // The foreground pass while the oracle says offline: refused, as before.
    await expect(rigged.session.pullNow()).resolves.toBe(false);
    expect(rigged.attempts()).toBe(0);
    // Nothing wakes this session now — no radio event, no foreground frame, no
    // manual refresh. The retry the refusal scheduled is the only thing left,
    // and before #1011 there was none.
    connected = true;
    await expect(until(() => rigged.attempts() > 0)).resolves.toBe(true);
  });

  it("keeps refusing while it is genuinely offline", async () => {
    const root = tempDirSync("native-session-catchup-");
    const rigged = await rig({
      file: path.join(root, "seat.db"),
      connected: () => false,
      outcome: () => Promise.resolve(WATERMARK),
    });
    await expect(rigged.session.pullNow()).resolves.toBe(false);
    // The retry fires and finds the same answer: refused, never a request.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(rigged.attempts()).toBe(0);
  });
});

describe("what a catch-up that did not land says about itself", () => {
  afterEach(async () => {
    await forEachSequentially(open.splice(0), (session) =>
      session.close().catch(() => undefined)
    );
  });

  it("keeps the failure's reason, and clears it when one lands", async () => {
    const root = tempDirSync("native-session-catchup-");
    let fail = true;
    const rigged = await rig({
      file: path.join(root, "seat.db"),
      connected: () => true,
      outcome: () =>
        fail
          ? Promise.reject(new Error("seat log door answered 403: forbidden"))
          : Promise.resolve(WATERMARK),
    });
    await expect(rigged.session.pullNow()).resolves.toBe(false);
    expect(String((rigged.session.lastSyncError as Error).message)).toContain(
      "403"
    );
    fail = false;
    await expect(rigged.session.pullNow()).resolves.toBe(true);
    expect(rigged.session.lastSyncError).toBeUndefined();
  });
});
