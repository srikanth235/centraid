/*
 * SEEDED COMPOSITION-CHAOS LANE (umbrella #842, W3.2).
 *
 * W3.1 breaks the LINK between two healthy components. This lane breaks the
 * COMPONENTS while the system is mid-work — the gateway, the replica, the
 * automation worker, the model runtime — and asserts that the system converges
 * rather than corrupting or wedging.
 *
 * Everything here is real: a real vault plane on a real directory (stopped and
 * REOPENED FROM DISK for the restart faults), the real replica-intent route
 * over a real loopback HTTP hop, the real durable client outbox on a real
 * file, the real persisted automation turn-claim, and the real device
 * enrichment lease queue. The two lease-shaped faults use each primitive's
 * INJECTABLE clock rather than waiting out a TTL, so the lane has no
 * wall-clock sleep and asserts no timing.
 *
 * REPLAY. The schedule is the same seeded cover/sample design as W3.1 and the
 * #842 W1.1 crash lane, so a red case replays from the seed in its own name:
 *
 *     CENTRAID_CHAOS_SEED=0x3a7c1e05 bunx vitest run \
 *       --config vitest.quality.config.ts \
 *       tests/quality/component-chaos.integration.test.ts
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { ConversationStore } from "../../packages/server/src/engine/conversation/store.js";
import { ensureConversationLedger } from "../../packages/server/src/engine/stores/gateway-db.js";
import {
  completeEnrichmentLease,
  enrichmentQueueDepth,
  leaseNextEnrichmentRequest,
  queueDeviceEnrichmentRequest,
} from "../../packages/vault/src/enrich/leases.js";
import {
  chaosSchedule,
  replayLabel,
  resolvedSchedule,
} from "./chaos-schedule.js";
import type { ChaosScheduleEntry } from "./chaos-schedule.js";
import { openComponentChaosWorld } from "./component-chaos-world.js";
import type { ComponentChaosWorld } from "./component-chaos-world.js";
import {
  COMPONENT_FAULT_BY_ID,
  COMPONENT_FAULT_IDS,
  COMPONENT_FAULTS,
  COMPONENTS_UNDER_CHAOS,
} from "./component-faults.js";
import type { ComponentFaultId } from "./component-faults.js";

// Every case boots (and some reboot) a real vault on disk. Above the node
// default deliberately, as a file budget rather than a per-test cap.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** A fixed instant. Never `Date.now()` — a lease law read off the wall clock
 * is a different test every run, and these are all clock-shaped. */
const T0 = Date.parse("2026-08-21T00:00:00.000Z");
const MINUTE = 60_000;
/** `ConversationStore.acquireTurnLock` treats a claim older than this as dead. */
const TURN_LOCK_STALE_MS = 30 * MINUTE;
/** `leaseNextEnrichmentRequest` default TTL. */
const LEASE_TTL_MS = 10 * MINUTE;
/** How many consecutive worker deaths the bounded-resource claim survives. */
const DEATHS = 3;

const worlds: ComponentChaosWorld[] = [];

async function world(): Promise<ComponentChaosWorld> {
  const opened = await openComponentChaosWorld();
  worlds.push(opened);
  return opened;
}

afterEach(async () => {
  for (const opened of worlds.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- one world torn down at a time
    await opened.close();
  }
});

const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

interface OutcomeAnswer {
  status: number;
  outcome: { intentId: string; status: string } | undefined;
}

/** Enqueue, claim, and submit one intent; returns the route's answer. */
async function sendOnce(
  chaos: ComponentChaosWorld,
  queue: import("../../packages/client/src/replica/intents.js").IntentQueue,
  intentId: string,
  title: string
): Promise<OutcomeAnswer> {
  await queue.enqueue({
    intentId,
    appId: "planner",
    action: "add_task",
    input: { title },
  });
  const claimed = await queue.claimNext();
  return chaos.submit(claimed);
}

/*
 * THE GATEWAY DIES INSIDE DISPATCH. The vault command already committed; the
 * outcome row never did. The plane is then reopened from disk and the client
 * retries under the SAME intent id. Exactly-once here is the canonical commit
 * marker doing its job — a retry that re-executed would leave two tasks.
 */
async function gatewayRestartMidDispatch(
  chaos: ComponentChaosWorld
): Promise<void> {
  const outbox = chaos.openOutbox();
  const queue = outbox.queue;

  const first = await sendOnce(chaos, queue, "chaos-gw-a", "before the crash");
  expect(first.outcome?.status).toBe("executed");
  await queue.awaitingChange("chaos-gw-a");
  await queue.applyOutcomes([
    { intentId: "chaos-gw-a", status: "executed" } as never,
  ]);

  chaos.setBackend("dying");
  const crashed = await sendOnce(
    chaos,
    queue,
    "chaos-gw-b",
    "across the crash"
  );
  // Not terminal: admission survived, the outcome did not, so the client is
  // told the work is still in flight rather than that it failed.
  expect(crashed.status).toBe(202);
  expect(crashed.outcome?.status).toBe("in-flight");

  // A REAL restart: the plane is stopped and reopened from the same directory.
  chaos.restartGateway();
  chaos.setBackend("healthy");
  await queue.transportFailed("chaos-gw-b", "gateway restart");
  const replayed = await queue.claimNext();
  expect(replayed?.intentId).toBe("chaos-gw-b");
  const settled = await chaos.submit(replayed);
  expect(settled.outcome?.status).toBe("executed");
  await queue.awaitingChange("chaos-gw-b");
  await queue.applyOutcomes([
    { intentId: "chaos-gw-b", status: "executed" } as never,
  ]);

  // Converged, not corrupted: one row per intent across a real restart.
  expect(chaos.taskTitles()).toStrictEqual([
    "across the crash",
    "before the crash",
  ]);
  expect(chaos.executedOutcomeCount()).toBe(2);
  await expect(queue.pending()).resolves.toStrictEqual([]);
}

/*
 * THE GATEWAY IS DEGRADED, NOT DEAD. Its backend answers the product's own
 * non-terminal `retryable` for the whole window. Nothing may be applied and
 * nothing may be lost; recovery drains the outbox exactly once.
 */
async function gatewayBackendDegraded(
  chaos: ComponentChaosWorld
): Promise<void> {
  const queue = chaos.openOutbox().queue;
  chaos.setBackend("degraded");
  const refused = await sendOnce(
    chaos,
    queue,
    "chaos-degraded",
    "through the degradation"
  );
  expect(refused.status).toBe(202);
  expect(refused.outcome?.status).toBe("in-flight");
  // Refused as a state, never as a half-applied write.
  expect(chaos.taskTitles()).toStrictEqual([]);
  expect(chaos.executedOutcomeCount()).toBe(0);
  // The work is still owed: the durable outbox kept it.
  await queue.transportFailed("chaos-degraded", "degraded backend");
  expect(
    (await queue.pending()).map((intent) => intent.intentId)
  ).toStrictEqual(["chaos-degraded"]);

  chaos.setBackend("healthy");
  const recovered = await queue.claimNext();
  const settled = await chaos.submit(recovered);
  expect(settled.outcome?.status).toBe("executed");
  await queue.awaitingChange("chaos-degraded");
  await queue.applyOutcomes([
    { intentId: "chaos-degraded", status: "executed" } as never,
  ]);
  expect(chaos.taskTitles()).toStrictEqual(["through the degradation"]);
  expect(chaos.executedOutcomeCount()).toBe(1);
  await expect(queue.pending()).resolves.toStrictEqual([]);
}

/*
 * THE REPLICA'S PROCESS DIES with an intent CLAIMED and unanswered. The outbox
 * is a real file, so closing it is a real death: the reopened store must still
 * hold the claim, the product's own `recoverSending` must return it to queued,
 * and the replay must apply exactly once under the same id and payload hash.
 */
async function replicaProcessDeathMidSend(
  chaos: ComponentChaosWorld
): Promise<void> {
  const first = chaos.openOutbox();
  await first.queue.enqueue({
    intentId: "chaos-replica",
    appId: "planner",
    action: "add_task",
    input: { title: "claimed when the phone died" },
  });
  const claimed = await first.queue.claimNext();
  expect(claimed?.state).toBe("sending");
  first.close();

  // Reopened from the same file — a restart, not a fresh install.
  const reopened = chaos.openOutbox();
  const survivors = await reopened.queue.pending();
  expect(survivors.map((intent) => intent.intentId)).toStrictEqual([
    "chaos-replica",
  ]);
  expect(survivors[0]?.state).toBe("sending");

  const recovered = await reopened.queue.recoverSending();
  expect(recovered.map((intent) => intent.state)).toStrictEqual(["queued"]);
  const replayed = await reopened.queue.claimNext();
  // Same identity AND same payload hash: recovery replays the work, it does
  // not re-derive it, so the gateway's dedupe can recognise it.
  expect(replayed?.intentId).toBe(claimed?.intentId);
  expect(replayed?.payloadHash).toBe(claimed?.payloadHash);

  const settled = await chaos.submit(replayed);
  expect(settled.outcome?.status).toBe("executed");
  await reopened.queue.awaitingChange("chaos-replica");
  await reopened.queue.applyOutcomes([
    { intentId: "chaos-replica", status: "executed" } as never,
  ]);

  // A second delivery of the very same claim (the classic post-crash double
  // send) is a dedupe hit, not a second task.
  const duplicate = await chaos.submit(replayed);
  expect(duplicate.outcome?.status).toBe("executed");
  expect(chaos.taskTitles()).toStrictEqual(["claimed when the phone died"]);
  expect(chaos.executedOutcomeCount()).toBe(1);
  await expect(reopened.queue.pending()).resolves.toStrictEqual([]);
}

/*
 * AN AUTOMATION WORKER DIES HOLDING THE RUN CLAIM. The claim is persisted
 * cross-process state, so nothing cleans it up when the worker vanishes. The
 * law is two-sided: a LIVE claim cannot be stolen, and a DEAD one is reclaimed
 * at a bounded lease age rather than wedging the conversation forever.
 */
function automationWorkerDeathHoldingClaim(chaos: ComponentChaosWorld): void {
  const plane = chaos.plane();
  ensureConversationLedger(plane.db.journal);
  const store = new ConversationStore(() => plane.db.journal);
  const conversationId = "chaos-automation";
  store.createConversation({
    id: conversationId,
    kind: "automation",
    userId: plane.boot.ownerPartyId,
    appId: "quality",
    automationId: "quality/chaos",
  });

  expect(store.acquireTurnLock(conversationId, "worker-a", T0)).toBe(true);
  // A live claim is not stealable — this is the single-writer guarantee.
  expect(
    store.acquireTurnLock(conversationId, "worker-b", T0 + MINUTE),
    "a live automation claim was stolen"
  ).toBe(false);

  // worker-a dies here, holding the claim and releasing nothing.
  expect(
    store.acquireTurnLock(
      conversationId,
      "worker-b",
      T0 + TURN_LOCK_STALE_MS - MINUTE
    ),
    "a claim inside its lease was reclaimed early"
  ).toBe(false);
  // BOUNDED: the wedge ends by itself at the lease age; it is not forever.
  expect(
    store.acquireTurnLock(
      conversationId,
      "worker-b",
      T0 + TURN_LOCK_STALE_MS + MINUTE
    ),
    "a dead worker wedged the conversation past its lease"
  ).toBe(true);

  // The dead worker can neither revive its claim...
  expect(
    store.refreshTurnLock(
      conversationId,
      "worker-a",
      T0 + TURN_LOCK_STALE_MS + 2 * MINUTE
    )
  ).toBe(false);
  // ...nor release the successor's.
  store.releaseTurnLock(conversationId, "worker-a");
  expect(
    store.acquireTurnLock(
      conversationId,
      "worker-c",
      T0 + TURN_LOCK_STALE_MS + 3 * MINUTE
    ),
    "a dead worker's release freed the successor's claim"
  ).toBe(false);

  // BOUNDED RESOURCE USE: a chain of deaths leaves one row, not a pile.
  const rows = (
    plane.db.journal
      .prepare("SELECT count(*) AS n FROM conversation_turn_locks")
      .get() as { n: number }
  ).n;
  expect(rows, "turn-claim rows after the worker chain").toBe(1);
}

/*
 * A MODEL-RUNTIME WORKER DIES HOLDING AN ENRICHMENT LEASE, repeatedly. Same
 * two-sided law as the automation claim, plus the queue-shape claim that makes
 * it a bounded-resource statement: a job re-leased after N deaths is still ONE
 * job with N+1 attempts, never N copies, and the dead worker's late completion
 * cannot drain the successor's work.
 */
function modelRuntimeDeathHoldingLease(chaos: ComponentChaosWorld): void {
  const vault = chaos.plane().db.vault;
  const requestId = "chaos-enrich";
  queueDeviceEnrichmentRequest(vault, {
    requestId,
    entityType: "core.content_item",
    entityId: "content-chaos",
    capability: "pdfText",
    contributionVariant: "text",
    requestedAt: iso(0),
  });

  let at = 0;
  for (let death = 0; death < DEATHS; death += 1) {
    const token = `token-${death}`;
    const lease = leaseNextEnrichmentRequest(vault, {
      deviceId: `worker-${death}`,
      capabilities: ["pdfText"],
      now: iso(at),
      ttlMs: LEASE_TTL_MS,
      token,
    });
    expect(lease?.requestId, `lease ${death} was not handed out`).toBe(
      requestId
    );
    expect(
      lease?.attempt,
      "attempts must count deaths, not multiply jobs"
    ).toBe(death + 1);
    // No double-hand-out while the lease is live.
    expect(
      leaseNextEnrichmentRequest(vault, {
        deviceId: "thief",
        capabilities: ["pdfText"],
        now: iso(at + MINUTE),
      }),
      "a live enrichment lease was handed to a second worker"
    ).toBeNull();

    // The worker dies here: no contribution, no release.
    at += LEASE_TTL_MS + MINUTE;
    // The dead worker's late completion is refused and drains nothing.
    expect(
      completeEnrichmentLease(vault, {
        requestId,
        deviceId: `worker-${death}`,
        token,
        now: iso(at),
      }),
      "a dead worker completed a lease it no longer holds"
    ).toBe(false);
  }

  // Converged shape: exactly one job, available again, never drained by a
  // worker that did no work.
  const depth = enrichmentQueueDepth(vault, iso(at));
  expect(depth.total, "one job per request, whatever died holding it").toBe(1);
  expect(depth.leased, "no live lease survives its dead owner").toBe(0);
  expect(depth.available, "the job is reclaimable after the deaths").toBe(1);
  expect(
    (
      vault
        .prepare(
          "SELECT lease_attempts AS n FROM enrich_request WHERE request_id = ?"
        )
        .get(requestId) as { n: number }
    ).n,
    "attempts grow by exactly one per death"
  ).toBe(DEATHS);
}

const SCENARIOS: Record<
  ComponentFaultId,
  (chaos: ComponentChaosWorld) => void | Promise<void>
> = {
  "gateway-restart-mid-dispatch": gatewayRestartMidDispatch,
  "gateway-backend-degraded": gatewayBackendDegraded,
  "replica-process-death-mid-send": replicaProcessDeathMidSend,
  "automation-worker-death-holding-claim": automationWorkerDeathHoldingClaim,
  "model-runtime-death-holding-lease": modelRuntimeDeathHoldingLease,
};

const schedule = resolvedSchedule(COMPONENT_FAULT_IDS);

describe("seeded composition-chaos lane: replay and coverage", () => {
  test("chaosSchedule replays byte-for-byte from its seed", () => {
    expect(chaosSchedule(COMPONENT_FAULT_IDS, 0xc0_ff_ee_01)).toStrictEqual(
      chaosSchedule(COMPONENT_FAULT_IDS, 0xc0_ff_ee_01)
    );
    expect(chaosSchedule(COMPONENT_FAULT_IDS, 0xc0_ff_ee_01)).not.toStrictEqual(
      chaosSchedule(COMPONENT_FAULT_IDS, 0x0d_15_ea_5e)
    );
    // Cover mode is a permutation, so no fault can quietly leave the lane.
    expect(
      [...chaosSchedule(COMPONENT_FAULT_IDS, 7).map((e) => e.fault)].sort()
    ).toEqual([...COMPONENT_FAULT_IDS].sort());
  });

  // Every component #842 W3.2 names is degraded by at least one fault, and
  // every catalog fault has a scenario. A component that lost its fault would
  // otherwise leave a hole this lane silently reads as green.
  test("every named component is degraded by a scenario in this lane", () => {
    for (const component of COMPONENTS_UNDER_CHAOS) {
      expect(
        COMPONENT_FAULTS.filter((fault) => fault.component === component),
        `no fault degrades ${component}`
      ).not.toStrictEqual([]);
    }
    expect(Object.keys(SCENARIOS).sort()).toStrictEqual(
      [...COMPONENT_FAULT_IDS].sort()
    );
    expect(
      [...new Set(COMPONENT_FAULTS.map((fault) => fault.component))].sort()
    ).toStrictEqual([...COMPONENTS_UNDER_CHAOS].sort());
  });
});

describe("seeded composition-chaos lane: components die mid-work", () => {
  test.each(
    schedule.map((entry): [string, ChaosScheduleEntry<ComponentFaultId>] => [
      `${entry.fault} (${replayLabel(entry)}) converges rather than corrupting or wedging`,
      entry,
    ])
  )("%s", async (_name, entry) => {
    const fault = COMPONENT_FAULT_BY_ID[entry.fault];
    expect(
      fault.invariant.length,
      "every fault states its invariant"
    ).toBeGreaterThan(20);
    const chaos = await world();
    await SCENARIOS[entry.fault](chaos);
  });
});
