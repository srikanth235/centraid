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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MAX_ATTEMPTS = 3;

const AMPLIFICATION_FACTOR = 8;

const worlds: ChaosIntentWorld[] = [];

async function world(label: string): Promise<ChaosIntentWorld> {
  const opened = await openChaosIntentWorld(label);
  worlds.push(opened);
  return opened;
}

async function closeWorlds(): Promise<void> {
  for (const opened of worlds.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- one world torn down at a time
    await opened.close();
  }
}

interface DriveResult {
  readonly attempts: number;
  readonly streams: number;
  readonly sentBytes: number;
  readonly payloadBytes: number;
  readonly failures: string[];
  readonly outcomes: string[];
  readonly lastBody: string;
}

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
  const outcomes: string[] = [];
  let lastBody = "";
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
      lastBody = answer.body.toString("utf8");
      const parsed = JSON.parse(lastBody) as { outcome: IntentOutcome };
      outcomes.push(String(parsed.outcome.status));
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
  return {
    attempts,
    streams,
    sentBytes,
    payloadBytes,
    failures,
    outcomes,
    lastBody,
  };
}

const seed = resolveChaosSeed();
const schedule = resolvedSchedule(RUNNABLE_NETWORK_FAULT_IDS);

describe("seeded network-chaos lane: replay and honesty", () => {
  test("chaosSchedule replays byte-for-byte from its seed", () => {
    const catalog = RUNNABLE_NETWORK_FAULT_IDS;
    expect(chaosSchedule(catalog, 0x1234_5678)).toStrictEqual(
      chaosSchedule(catalog, 0x1234_5678)
    );
    expect(chaosSchedule(catalog, 0x1234_5678)).not.toStrictEqual(
      chaosSchedule(catalog, 0x8765_4321)
    );
    expect(
      chaosSchedule(catalog, seed)
        .map((entry) => entry.fault)
        .sort()
    ).toStrictEqual([...catalog].sort());
    const sampled = chaosSchedule(catalog, 42, {
      mode: "sample",
      iterations: 17,
    });
    expect(sampled).toStrictEqual(
      chaosSchedule(catalog, 42, { mode: "sample", iterations: 17 })
    );
    expect(sampled).toHaveLength(17);
  });

  test("the netem tier is declared, excluded, and cannot be claimed for free", () => {
    expect([...BLOCKED_NETWORK_FAULT_IDS]).toStrictEqual([
      "packet-loss",
      "packet-reorder",
    ]);
    for (const blocked of BLOCKED_NETWORK_FAULT_IDS) {
      expect(RUNNABLE_NETWORK_FAULT_IDS).not.toContain(blocked);
      expect(NETWORK_FAULT_BY_ID[blocked].invariant.length).toBeGreaterThan(20);
    }
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
    const chaos = await world(`${entry.fault}-${entry.step}`);
    const queue = chaosIntentQueue();
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
      await submit(0);
      if (entry.fault === "endpoint-restart")
        await chaos.restartGatewayEndpoint();
      else await chaos.rebindClient();
      await submit(1);
    } else {
      await submit(0);
    }

    expect(chaos.gatewayEndpointId(), "gateway identity across the case").toBe(
      gatewayBefore
    );
    expect(chaos.deviceEndpointId(), "device identity across the case").toBe(
      deviceBefore
    );

    for (const drive of drives) {
      expect(
        drive.outcomes.at(-1),
        `last wire outcome under ${entry.fault}: ${drive.lastBody || drive.failures.join(" | ")}`
      ).toBe("executed");
    }

    expect(chaos.taskTitles(), fault.invariant).toStrictEqual(
      [...titles].sort()
    );
    expect(
      chaos.executedOutcomeCount(),
      `executed outcomes after ${fault.injection}`
    ).toBe(titles.length);

    await expect(queue.pending()).resolves.toStrictEqual([]);
    const settled = await queue.listSettled();
    expect(
      settled.filter((outcome) => outcome.status === "executed"),
      "client-settled outcomes vs vault rows"
    ).toHaveLength(titles.length);

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
    const interrupting =
      entry.fault === "abort-mid-request" ||
      entry.fault === "disconnect-mid-response";
    const injected = drives[0]!.failures.filter((failure) =>
      failure.includes(`chaos[${entry.fault}]`)
    ).length;
    expect(
      injected,
      `${entry.fault} injection count on the first attempt`
    ).toBe(interrupting ? 1 : 0);
    expect(
      drives[0]!.attempts,
      `attempts on the first write under ${entry.fault}`
    ).toBe(interrupting ? 2 : 1);
  });

  test("a declared-huge header frame is refused at the cap and does not wedge the link", async () => {
    const chaos = await world("header-frame-cap");
    const rng = seededRandom(seed);
    const dial = await chaos.dial("recovered", rng);

    const stalled = await dial.connection.openBi();
    await stalled.send.writeAll([0x40, 0, 0, 0]);
    await stalled.send.writeAll([0x7b, 0x22, 0x74, 0x22]);

    const refusalLength = Buffer.from(
      await stalled.recv.readExact(4)
    ).readUInt32BE(0);
    expect(refusalLength).toBeLessThanOrEqual(4096);
    const refusal = JSON.parse(
      Buffer.from(await stalled.recv.readExact(refusalLength)).toString("utf8")
    ) as { status: number };
    expect(refusal.status, "an over-cap header frame must be refused").toBe(
      400
    );

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
