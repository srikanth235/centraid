import { afterEach, describe, expect, test, vi } from "vitest";

import { ConversationStore } from "../../packages/server/src/engine/conversation/store.js";
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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const T0 = Date.parse("2026-08-21T00:00:00.000Z");
const MINUTE = 60_000;
const TURN_LOCK_STALE_MS = 30 * MINUTE;
const LEASE_TTL_MS = 10 * MINUTE;
const DEATHS = 3;

const worlds: ComponentChaosWorld[] = [];

async function world(): Promise<ComponentChaosWorld> {
  const opened = await openComponentChaosWorld();
  worlds.push(opened);
  return opened;
}

async function closeWorlds(): Promise<void> {
  for (const opened of worlds.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- one world torn down at a time
    await opened.close();
  }
}

const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

interface OutcomeAnswer {
  status: number;
  outcome: { intentId: string; status: string } | undefined;
}

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
  expect(crashed.status).toBe(202);
  expect(crashed.outcome?.status).toBe("in-flight");

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

  expect(chaos.taskTitles()).toStrictEqual([
    "across the crash",
    "before the crash",
  ]);
  expect(chaos.executedOutcomeCount()).toBe(2);
  await expect(queue.pending()).resolves.toStrictEqual([]);
}

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
  expect(chaos.taskTitles()).toStrictEqual([]);
  expect(chaos.executedOutcomeCount()).toBe(0);
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

  const reopened = chaos.openOutbox();
  const survivors = await reopened.queue.pending();
  expect(survivors.map((intent) => intent.intentId)).toStrictEqual([
    "chaos-replica",
  ]);
  expect(survivors[0]?.state).toBe("sending");

  const recovered = await reopened.queue.recoverSending();
  expect(recovered.map((intent) => intent.state)).toStrictEqual(["queued"]);
  const replayed = await reopened.queue.claimNext();
  expect(replayed?.intentId).toBe(claimed?.intentId);
  expect(replayed?.payloadHash).toBe(claimed?.payloadHash);

  const settled = await chaos.submit(replayed);
  expect(settled.outcome?.status).toBe("executed");
  await reopened.queue.awaitingChange("chaos-replica");
  await reopened.queue.applyOutcomes([
    { intentId: "chaos-replica", status: "executed" } as never,
  ]);

  const duplicate = await chaos.submit(replayed);
  expect(duplicate.outcome?.status).toBe("executed");
  expect(chaos.taskTitles()).toStrictEqual(["claimed when the phone died"]);
  expect(chaos.executedOutcomeCount()).toBe(1);
  await expect(reopened.queue.pending()).resolves.toStrictEqual([]);
}

function automationWorkerDeathHoldingClaim(chaos: ComponentChaosWorld): void {
  const plane = chaos.plane();
  const store = new ConversationStore(() => plane.db.audit);
  const conversationId = "chaos-automation";
  store.createConversation({
    id: conversationId,
    kind: "automation",
    userId: plane.boot.ownerPartyId,
    appId: "quality",
    automationId: "quality/chaos",
  });

  expect(store.acquireTurnLock(conversationId, "worker-a", T0)).toBe(true);
  expect(
    store.acquireTurnLock(conversationId, "worker-b", T0 + MINUTE),
    "a live automation claim was stolen"
  ).toBe(false);

  expect(
    store.acquireTurnLock(
      conversationId,
      "worker-b",
      T0 + TURN_LOCK_STALE_MS - MINUTE
    ),
    "a claim inside its lease was reclaimed early"
  ).toBe(false);
  expect(
    store.acquireTurnLock(
      conversationId,
      "worker-b",
      T0 + TURN_LOCK_STALE_MS + MINUTE
    ),
    "a dead worker wedged the conversation past its lease"
  ).toBe(true);

  expect(
    store.refreshTurnLock(
      conversationId,
      "worker-a",
      T0 + TURN_LOCK_STALE_MS + 2 * MINUTE
    )
  ).toBe(false);
  store.releaseTurnLock(conversationId, "worker-a");
  expect(
    store.acquireTurnLock(
      conversationId,
      "worker-c",
      T0 + TURN_LOCK_STALE_MS + 3 * MINUTE
    ),
    "a dead worker's release freed the successor's claim"
  ).toBe(false);

  const rows = (
    plane.db.audit
      .prepare("SELECT count(*) AS n FROM conversation_turn_locks")
      .get() as { n: number }
  ).n;
  expect(rows, "turn-claim rows after the worker chain").toBe(1);
}

function modelRuntimeDeathHoldingLease(chaos: ComponentChaosWorld): void {
  const vault = chaos.plane().db.vault;
  const requestId = "chaos-enrich";
  vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'application/pdf', ?, ?, 4096, ?)`
    )
    .run("content-chaos", "vault://content-chaos", "sha-content-chaos", iso(0));
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
    expect(
      leaseNextEnrichmentRequest(vault, {
        deviceId: "thief",
        capabilities: ["pdfText"],
        now: iso(at + MINUTE),
      }),
      "a live enrichment lease was handed to a second worker"
    ).toBeNull();

    at += LEASE_TTL_MS + MINUTE;
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
    expect(
      chaosSchedule(COMPONENT_FAULT_IDS, 7)
        .map((entry) => entry.fault)
        .sort()
    ).toStrictEqual([...COMPONENT_FAULT_IDS].sort());
  });

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
  afterEach(closeWorlds);

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
