/*
 * SEEDED NETWORK-CHAOS LANE ON THE TUNNEL PLANE (umbrella #842, W3.1).
 *
 * The tunnel plane is proven on a COOPERATIVE network. `peer-plane.test.ts`,
 * `hostile-peer.integration.test.ts` and the #839 join lane all dial a real
 * iroh endpoint over a loopback that never delays, stalls, resets, or moves.
 * This lane injects the adversity a real link supplies and asserts what must
 * hold regardless: no data loss, no duplicate application, no silent
 * divergence, convergence once the network recovers, and bounded resource use
 * while it does not.
 *
 * The transport is REAL — a live iroh QUIC connection between two real
 * endpoints, forwarded to the real replica-intent route over the real app
 * engine into a real vault. The only synthetic part is the fault, applied at
 * the stream/connection/endpoint seams a QUIC transport actually exposes
 * (`chaos-link.ts`); `network-faults.ts` states why sub-QUIC loss and
 * reordering are declared at a `needs-netem` tier instead of faked here.
 *
 * REPLAY. The schedule is `chaosSchedule(seed)` — the same cover/sample design
 * as the #842 W1.1 crash lane. Every case name carries its seed and step, so a
 * red run replays from its own name:
 *
 *     CENTRAID_CHAOS_SEED=0x3a7c1e05 bunx vitest run \
 *       --config vitest.quality.config.ts \
 *       tests/quality/network-chaos.integration.test.ts
 *
 * PR runs "cover" (every fault exactly once, ordering seeded); nightly sets
 * CENTRAID_CHAOS_ITERATIONS to draw a longer sequence with repetition.
 *
 * Every assertion reads REAL post-chaos state — `schedule_task` rows,
 * `replica_intent_outcome` rows, the client's own durable outbox — never a log
 * line and never a timing. A breached invariant here is a real defect to PIN.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { seededRandom } from "@centraid/test-kit/random";
import type { SeededRandom } from "@centraid/test-kit/random";

import type { IntentQueue } from "../../packages/client/src/replica/intents.js";
import type { IntentOutcome } from "../../packages/client/src/replica/types.js";
import { tunnelRequest } from "../../packages/tunnel/src/index.js";
import {
  chaosIntentQueue,
  INTENT_PATH,
  openChaosIntentWorld,
} from "./chaos-intent-world.js";
import type { ChaosIntentWorld } from "./chaos-intent-world.js";
import {
  chaosSchedule,
  replayLabel,
  resolveChaosSeed,
  resolvedSchedule,
} from "./chaos-schedule.js";
import type { ChaosScheduleEntry } from "./chaos-schedule.js";
import {
  BLOCKED_NETWORK_FAULT_IDS,
  NETEM_ENV,
  NETEM_UNBLOCK,
  NETWORK_FAULT_BY_ID,
  NETWORK_FAULTS,
  RUNNABLE_NETWORK_FAULT_IDS,
} from "./network-faults.js";
import type { NetworkFaultId } from "./network-faults.js";

// Every case boots a real vault, a real app registry, and two real iroh
// endpoints; the throttled and fragmented faults then push a few hundred bytes
// through in metered pieces. Well above the node default, deliberately ABOVE
// its file budget rather than a per-test cap under it (TESTING.md).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** One chaotic attempt, then at most one on the recovered link. */
const MAX_ATTEMPTS = 3;

/**
 * Amplification ceiling: the whole point of a bounded-resource claim is that a
 * bad network cannot make the product send unboundedly more than the payload.
 * Three attempts of one small JSON request is the structural worst case here,
 * so eight times the largest single attempt is a generous but real ceiling —
 * a retry storm or an un-acked resend loop blows straight through it.
 */
const AMPLIFICATION_FACTOR = 8;

const worlds: ChaosIntentWorld[] = [];

async function world(): Promise<ChaosIntentWorld> {
  const opened = await openChaosIntentWorld();
  worlds.push(opened);
  return opened;
}

async function closeWorlds(): Promise<void> {
  for (const opened of worlds.splice(0)) {
    // Sequential on purpose: each world owns iroh endpoints and a vault whose
    // teardown must complete before the next reclaims the same temp roots.
    // oxlint-disable-next-line no-await-in-loop -- one world torn down at a time
    await opened.close();
  }
}

interface DriveResult {
  readonly attempts: number;
  readonly streams: number;
  readonly sentBytes: number;
  /** The largest single request body this drive put on the wire. */
  readonly payloadBytes: number;
  readonly failures: string[];
}

/**
 * Push ONE pending intent through the chaotic link until it settles: the first
 * attempt rides the named fault, and any retry rides the recovered link. This
 * is the product's own durable-outbox loop (claim → send → apply, or claim →
 * transportFailed), not a bespoke retry the test invented.
 */
async function driveIntent(
  chaos: ChaosIntentWorld,
  queue: IntentQueue,
  intentId: string,
  fault: NetworkFaultId,
  rng: SeededRandom
): Promise<DriveResult> {
  let attempts = 0;
  let streams = 0;
  let sentBytes = 0;
  let payloadBytes = 0;
  const failures: string[] = [];
  let settled = false;
  while (!settled && attempts < MAX_ATTEMPTS) {
    // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
    const pending = await queue.pending();
    const claimed = pending.some((intent) => intent.intentId === intentId)
      ? // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
        await queue.claimNext()
      : undefined;
    if (!claimed) {
      settled = true;
      continue;
    }
    attempts += 1;
    // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
    const dial = await chaos.dial(attempts === 1 ? fault : "recovered", rng);
    const payload = Buffer.from(JSON.stringify(claimed));
    payloadBytes = Math.max(payloadBytes, payload.length);
    try {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      const answer = await tunnelRequest(dial.connection, {
        method: "POST",
        target: INTENT_PATH,
        headers: { "content-type": "application/json" },
        body: payload,
      });
      const parsed = JSON.parse(answer.body.toString("utf8")) as {
        outcome: IntentOutcome;
      };
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await queue.awaitingChange(intentId);
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await queue.applyOutcomes([parsed.outcome]);
    } catch (error) {
      failures.push(String(error));
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await queue.transportFailed(intentId, "chaos");
    } finally {
      streams += dial.meter.streams;
      sentBytes += dial.meter.sentBytes;
      dial.close();
    }
  }
  return { attempts, streams, sentBytes, payloadBytes, failures };
}

const seed = resolveChaosSeed();
const schedule = resolvedSchedule(RUNNABLE_NETWORK_FAULT_IDS);

describe("seeded network-chaos lane: replay and honesty", () => {
  // The determinism the whole lane rests on: same seed, same fault sequence,
  // so a red case replays from the seed printed in its own name. In-process,
  // no transport, so this is the cheap guard the receipt cites for replay.
  test("chaosSchedule replays byte-for-byte from its seed", () => {
    const catalog = RUNNABLE_NETWORK_FAULT_IDS;
    expect(chaosSchedule(catalog, 0x1234_5678)).toStrictEqual(
      chaosSchedule(catalog, 0x1234_5678)
    );
    expect(chaosSchedule(catalog, 0x1234_5678)).not.toStrictEqual(
      chaosSchedule(catalog, 0x8765_4321)
    );
    // Cover mode is a permutation: every fault exactly once, never a subset.
    expect(
      [...chaosSchedule(catalog, seed).map((e) => e.fault)].sort()
    ).toEqual([...catalog].sort());
    const sampled = chaosSchedule(catalog, 42, {
      mode: "sample",
      iterations: 17,
    });
    expect(sampled).toStrictEqual(
      chaosSchedule(catalog, 42, { mode: "sample", iterations: 17 })
    );
    expect(sampled).toHaveLength(17);
  });

  /*
   * BLOCKED-EXTERNAL HONESTY. Sub-QUIC loss and reordering need a privileged
   * runner; they are declared in the catalog, excluded from the runnable
   * schedule, and CANNOT be claimed for free — setting the env flag that says
   * "the netem rig exists" fails this test while no driver is wired, so
   * "available but did not run" can never read as green.
   */
  test("the netem tier is declared, excluded, and cannot be claimed for free", () => {
    expect([...BLOCKED_NETWORK_FAULT_IDS]).toStrictEqual([
      "packet-loss",
      "packet-reorder",
    ]);
    for (const blocked of BLOCKED_NETWORK_FAULT_IDS) {
      expect(RUNNABLE_NETWORK_FAULT_IDS).not.toContain(blocked);
      expect(NETWORK_FAULT_BY_ID[blocked].invariant.length).toBeGreaterThan(20);
    }
    // Every catalog entry belongs to exactly one tier, and the runnable half
    // is what the schedule enumerates — an entry cannot go missing silently.
    expect(
      RUNNABLE_NETWORK_FAULT_IDS.length + BLOCKED_NETWORK_FAULT_IDS.length
    ).toBe(NETWORK_FAULTS.length);
    expect(
      process.env[NETEM_ENV],
      `${NETEM_ENV} claims a privileged netem rig, but no driver is wired here. ` +
        `Unblock condition: ${NETEM_UNBLOCK}`
    ).toBeUndefined();
  });
});

describe("seeded network-chaos lane: the tunnel plane under adversity", () => {
  afterEach(closeWorlds);

  test.each(
    schedule.map((entry): [string, ChaosScheduleEntry<NetworkFaultId>] => [
      `${entry.fault} (${replayLabel(entry)}) loses nothing, applies once, and converges`,
      entry,
    ])
  )("%s", async (_name, entry) => {
    const fault = NETWORK_FAULT_BY_ID[entry.fault];
    const chaos = await world();
    const queue = chaosIntentQueue();
    // Seeded per case from (seed, step): every draw the shim makes is
    // reproducible from the coordinate in this test's own name.
    const rng = seededRandom(entry.seed ^ (entry.step + 1));

    const gatewayBefore = chaos.gatewayEndpointId();
    const deviceBefore = chaos.deviceEndpointId();
    const titles: string[] = [];
    const drives: DriveResult[] = [];

    const submit = async (ordinal: number): Promise<void> => {
      const title = `chaos ${entry.fault} ${entry.step}.${ordinal}`;
      titles.push(title);
      await queue.enqueue({
        intentId: `chaos-${entry.fault}-${entry.step}-${ordinal}`,
        appId: "planner",
        action: "add_task",
        input: { title },
      });
      drives.push(
        await driveIntent(
          chaos,
          queue,
          `chaos-${entry.fault}-${entry.step}-${ordinal}`,
          entry.fault,
          rng
        )
      );
    };

    if (fault.scope === "endpoint") {
      // An endpoint fault is not a stream shape: work lands, the transport
      // moves underneath the client, and the NEXT work must still land. One
      // write on each side of the move is what makes that a real claim.
      await submit(0);
      if (entry.fault === "endpoint-restart")
        await chaos.restartGatewayEndpoint();
      else await chaos.rebindClient();
      await submit(1);
      // Identity is not address: both endpoints kept their keys, so the seat
      // is the same principal on the far side of the move.
      expect(
        chaos.gatewayEndpointId(),
        "gateway identity across the move"
      ).toBe(gatewayBefore);
      expect(chaos.deviceEndpointId(), "device identity across the move").toBe(
        deviceBefore
      );
    } else {
      await submit(0);
    }

    // NO DATA LOSS — every acknowledged write is in the vault, and NO
    // DUPLICATE APPLICATION — exactly one row per intent, never two.
    expect(chaos.taskTitles(), fault.invariant).toStrictEqual(
      [...titles].sort()
    );
    expect(
      chaos.executedOutcomeCount(),
      `executed outcomes after ${fault.injection}`
    ).toBe(titles.length);

    // CONVERGENCE — the durable outbox is empty once the network recovers, and
    // NO SILENT DIVERGENCE — what the client believes settled is exactly what
    // the vault holds.
    await expect(queue.pending()).resolves.toStrictEqual([]);
    const settled = await queue.listSettled();
    expect(
      settled.filter((outcome) => outcome.status === "executed"),
      "client-settled outcomes vs vault rows"
    ).toHaveLength(titles.length);

    // BOUNDED RESOURCE USE — a bad link costs bounded work: at most one retry
    // per write, and no send amplification beyond the ceiling.
    for (const drive of drives) {
      expect(
        drive.attempts,
        `attempts under ${entry.fault}: ${drive.failures.join(" | ")}`
      ).toBeLessThanOrEqual(2);
      expect(drive.streams, "streams opened per write").toBeLessThanOrEqual(2);
      expect(
        drive.sentBytes,
        `bytes on the wire vs a ${drive.payloadBytes}-byte payload (amplification ceiling)`
      ).toBeLessThanOrEqual(AMPLIFICATION_FACTOR * drive.payloadBytes);
    }
    // The two ambiguous faults MUST actually have failed an attempt; a shim
    // that quietly stopped injecting would otherwise pass this whole case.
    if (
      entry.fault === "abort-mid-request" ||
      entry.fault === "disconnect-mid-response"
    ) {
      expect(
        drives[0]?.failures[0],
        `${entry.fault} never actually interrupted the request`
      ).toContain(`chaos[${entry.fault}]`);
      expect(drives[0]?.attempts).toBe(2);
    }
  });

  /*
   * BOUNDED RESOURCE USE WHILE THE NETWORK DOES NOT RECOVER. A starved uplink
   * that declares an enormous header frame and then trickles must be refused
   * at the declared length — the gateway may not buffer toward a length a peer
   * merely claimed — and the connection must stay usable, so a stalled stream
   * cannot wedge the plane. Structural: a fixed number of round trips, no
   * wall-clock wait.
   */
  test("a declared-huge header frame is refused at the cap and does not wedge the link", async () => {
    const chaos = await world();
    const rng = seededRandom(seed);
    const dial = await chaos.dial("recovered", rng);

    // 1 GiB claimed, four bytes sent, then silence. `MAX_HEADER_FRAME_BYTES`
    // is 256 KiB, so this is refused on the LENGTH, before a byte is read.
    const stalled = await dial.connection.openBi();
    await stalled.send.writeAll([0x40, 0, 0, 0]);
    await stalled.send.writeAll([0x7b, 0x22, 0x74, 0x22]);

    // A fresh, well-formed write on a NEW stream still lands: the parked read
    // consumed neither the connection nor the gateway.
    const queue = chaosIntentQueue();
    await queue.enqueue({
      intentId: "chaos-header-cap",
      appId: "planner",
      action: "add_task",
      input: { title: "after the stall" },
    });
    const result = await driveIntent(
      chaos,
      queue,
      "chaos-header-cap",
      "latency-uniform",
      rng
    );
    expect(
      result.failures,
      "the link was wedged by the stalled stream"
    ).toStrictEqual([]);
    expect(chaos.taskTitles()).toStrictEqual(["after the stall"]);
    await expect(queue.pending()).resolves.toStrictEqual([]);
  });
});
