/*
 * Exit evidence for P5 lend/write (#726). Two in-process gateways over the
 * SAME real peer transport `lend-live-edge.test.ts` exercises for reads —
 * every frame below goes through the real `/centraid/_peer/lend/intent`
 * handler, `Gateway.invokeAsIdentity`, and the ordinary consent → contract →
 * execution → evidence pipeline.
 *
 * The claim under test throughout: a queued write from the audience is an
 * ORDINARY authored action at the origin — same consent, same receipts, same
 * journal — never a second write path.
 */

import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { currentReplicaLogState } from "@centraid/vault";
import type { CommandDefinition } from "@centraid/vault";

import { expectedPayloadHash } from "../routes/replica-intent-shape.js";
import { pushLendIntentOverPeer } from "./lend-client.js";
import { acceptLease } from "./lend-lease.js";
import { borrowedSlotsFor, lend } from "./lend.test-fixtures.js";
import {
  dialFrom,
  link,
  makeSide,
  routeFrom,
} from "./peer-give.test-fixtures.js";

const WRITE_SCOPE = [{ schema: "schedule" }];

function receiptsFor(
  side: ReturnType<typeof makeSide>,
  invocationId: string
): Array<{ decision: string; action: string }> {
  return side.vault.journal
    .prepare(
      "SELECT decision, action FROM consent_receipt WHERE invocation_id = ?"
    )
    .all(invocationId) as Array<{ decision: string; action: string }>;
}

function taskRow(
  side: ReturnType<typeof makeSide>,
  taskId: string
): { status: string; title: string } | undefined {
  return side.vault.vault
    .prepare("SELECT status, title FROM schedule_task WHERE task_id = ?")
    .get(taskId) as { status: string; title: string } | undefined;
}

function taskCount(side: ReturnType<typeof makeSide>): number {
  return (
    side.vault.vault
      .prepare("SELECT count(*) AS n FROM schedule_task")
      .get() as { n: number }
  ).n;
}

/** Insert a task directly (mirrors `commands/tasks.ts::addTask`) — the
 *  entity-level trigger still logs it to `replica_change`, exactly as an
 *  ordinary `invoke()` would, so baseVersions arithmetic is real either way. */
function seedTask(side: ReturnType<typeof makeSide>, title: string): string {
  const taskId = crypto.randomUUID();
  side.vault.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority, due_at,
          completed_at, effort_min, parent_task_id, rrule, remind_before_min)
       VALUES (?, ?, ?, NULL, 'needs-action', 0, NULL, NULL, NULL, NULL, NULL, NULL)`
    )
    .run(taskId, side.ownerPartyId, title);
  return taskId;
}

function currentVersion(
  side: ReturnType<typeof makeSide>,
  taskId: string
): number {
  const epoch = currentReplicaLogState(side.vault.vault).epoch;
  const row = side.vault.vault
    .prepare(
      `SELECT MAX(seq) AS seq FROM replica_change
        WHERE epoch = ? AND entity = 'schedule.task' AND row_id = ?`
    )
    .get(epoch, taskId) as { seq: number | null };
  return row.seq ?? 0;
}

interface Payload {
  action: string;
  input: unknown;
  baseVersions?: Array<{ entity: string; rowId: string; version: number }>;
}

/** The audience hashes against `edgeId` — the one identifier it actually
 *  knows, mirroring `lend-intent.ts` exactly (see its "Both identity columns
 *  collapse to edgeId" note) rather than the origin's internal grantee
 *  party id, which the audience never learns. */
function requestForEdge(edgeId: string, intentId: string, payload: Payload) {
  const baseVersions = payload.baseVersions ?? [];
  return {
    intentId,
    action: payload.action,
    input: payload.input,
    baseVersions,
    payloadHash: expectedPayloadHash(
      edgeId,
      payload.action,
      payload.input,
      baseVersions
    ),
  };
}

async function writeCapableEdge(edgeId = "edge-write-1") {
  const origin = makeSide(`ada-w-${crypto.randomUUID().slice(0, 8)}`);
  const audience = makeSide(`priya-w-${crypto.randomUUID().slice(0, 8)}`);
  await link(origin, audience);
  const borrowed = borrowedSlotsFor(audience);
  const opened = await lend(origin, audience, borrowed, {
    edgeId,
    itemType: "schedule.task",
    scopes: WRITE_SCOPE,
    verbs: "read+act",
  });
  return { origin, audience, borrowed, ...opened };
}

describe("a write-capable live edge (#726 P5)", () => {
  it("lands the audience's edit at the origin as an ordinary authored action, with a receipt", async () => {
    const { origin, audience, edge } = await writeCapableEdge();
    expect(edge.status).toBe("established");

    const request = requestForEdge(edge.edge_id, "intent-add-1", {
      action: "schedule.add_task",
      input: { title: "Buy milk" },
    });
    const result = await pushLendIntentOverPeer({
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      edgeId: edge.edge_id,
      request,
    });
    expect(result.state).toBe("answered");
    if (result.state !== "answered") throw new Error("unreachable");
    expect(result.frame.state).toBe("executed");
    expect(
      acceptLease(result.lease, {
        edgeId: edge.edge_id,
        originVaultId: origin.vaultId,
        audienceVaultId: audience.vaultId,
        originPublicKey: origin.publicKey,
      })
    ).toBe(true);
    if (result.frame.state !== "executed") throw new Error("not executed");
    const taskId = (result.frame.output as { task_id: string }).task_id;

    // The row is ORDINARY vault state — not a borrowed-store row, not
    // staged anywhere else.
    expect(taskRow(origin, taskId)).toMatchObject({
      title: "Buy milk",
      status: "needs-action",
    });
    // Hash-chained receipt, same journal every local action uses.
    const receipts = receiptsFor(origin, result.frame.invocationId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      decision: "allow",
      action: "act schedule.add_task",
    });

    // A resend of the SAME intent is a dedupe hit, not a second task.
    const replay = await pushLendIntentOverPeer({
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      edgeId: edge.edge_id,
      request,
    });
    expect(replay).toMatchObject({
      state: "answered",
      frame: { state: "executed", invocationId: result.frame.invocationId },
    });
    expect(taskCount(origin)).toBe(1);
  });

  it("reports a stale baseVersions edit as a structured conflict, distinguishable from a network failure", async () => {
    const { origin, audience, edge } = await writeCapableEdge(
      "edge-write-conflict"
    );
    const taskId = seedTask(origin, "Groceries");
    const staleVersion = currentVersion(origin, taskId);
    // The origin's OWN owner moves the task before the audience's queued
    // edit ever arrives — the race the audience must be told it lost.
    origin.vault.vault
      .prepare(
        "UPDATE schedule_task SET status = 'in-process' WHERE task_id = ?"
      )
      .run(taskId);
    expect(currentVersion(origin, taskId)).toBeGreaterThan(staleVersion);

    const request = requestForEdge(edge.edge_id, "intent-conflict-1", {
      action: "schedule.set_task_status",
      input: { task_id: taskId, status: "completed" },
      baseVersions: [
        { entity: "schedule.task", rowId: taskId, version: staleVersion },
      ],
    });
    const result = await pushLendIntentOverPeer({
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      edgeId: edge.edge_id,
      request,
    });
    expect(result.state).toBe("answered");
    if (result.state !== "answered") throw new Error("unreachable");
    expect(result.frame.state).toBe("conflict");
    if (result.frame.state !== "conflict") throw new Error("not a conflict");
    expect(result.frame.conflict).toMatchObject({
      entity: "schedule.task",
      rowId: taskId,
      expectedVersion: staleVersion,
    });
    expect(result.frame.conflict.actualVersion).toBeGreaterThan(staleVersion);
    // The row never moved to 'completed' — a conflict is a REFUSAL to write,
    // not a partial write.
    expect(taskRow(origin, taskId)?.status).toBe("in-process");

    // A conflict (a typed ANSWER) is a structurally different SHAPE from an
    // unreachable peer (no answer at all) — never conflated on the wire.
    const unreachable = await pushLendIntentOverPeer({
      dial: {
        request: () => Promise.reject(new Error("peer offline")),
        endpointTicketFor: () => "x",
      },
      route: routeFrom(audience, origin),
      edgeId: edge.edge_id,
      request: requestForEdge(edge.edge_id, "intent-conflict-2", {
        action: "schedule.set_task_status",
        input: { task_id: taskId, status: "completed" },
      }),
    });
    expect(unreachable.state).toBe("unreachable");
    expect("frame" in unreachable).toBe(false);
  });

  it("parks a Tier-3/4 write for the origin owner and completes only after confirmation", async () => {
    const { origin, audience, edge } =
      await writeCapableEdge("edge-write-park");
    const archiveTask: CommandDefinition = {
      name: "schedule.archive_task",
      ownerSchema: "schedule",
      inputSchema: {
        type: "object",
        required: ["task_id"],
        additionalProperties: false,
        properties: { task_id: { type: "string", minLength: 1 } },
      },
      outputSchema: { type: "object", properties: {} },
      preconditions: [],
      postconditions: [],
      idempotency: "once",
      risk: "low",
      // Loud on purpose (#306 decision 1) — every non-owner caller parks,
      // including a live edge's own grant identity.
      confirm: true,
      handler: (ctx) => {
        const input = ctx.input as { task_id: string };
        ctx.db
          .prepare(
            "UPDATE schedule_task SET status = 'cancelled' WHERE task_id = ?"
          )
          .run(input.task_id);
        ctx.wrote("schedule.task", input.task_id);
        return {};
      },
    };
    origin.gateway.registerCommand(archiveTask);
    const taskId = seedTask(origin, "Cancel me");

    const request = requestForEdge(edge.edge_id, "intent-park-1", {
      action: "schedule.archive_task",
      input: { task_id: taskId },
    });
    const parked = await pushLendIntentOverPeer({
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      edgeId: edge.edge_id,
      request,
    });
    expect(parked.state).toBe("answered");
    if (parked.state !== "answered") throw new Error("unreachable");
    expect(parked.frame.state).toBe("parked");
    if (parked.frame.state !== "parked") throw new Error("not parked");
    // Nothing wrote yet — a park is a pause, not a provisional write.
    expect(taskRow(origin, taskId)?.status).toBe("needs-action");

    // A resend before confirmation is the SAME frame answering a status
    // poll — still parked, no second invocation.
    const stillParked = await pushLendIntentOverPeer({
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      edgeId: edge.edge_id,
      request,
    });
    expect(stillParked).toMatchObject({
      state: "answered",
      frame: { state: "parked", invocationId: parked.frame.invocationId },
    });

    // The ORIGIN OWNER — never the audience — confirms, over the SAME
    // `Gateway.confirm` every other parked invocation uses.
    const outcome = origin.gateway.confirm(
      origin.ownerCredential,
      parked.frame.invocationId,
      true
    );
    expect(outcome.status).toBe("executed");
    expect(taskRow(origin, taskId)?.status).toBe("cancelled");

    // The audience learns the resolution through the SAME frame, no second
    // polling mechanism.
    const resolved = await pushLendIntentOverPeer({
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      edgeId: edge.edge_id,
      request,
    });
    expect(resolved).toMatchObject({
      state: "answered",
      frame: { state: "executed", invocationId: parked.frame.invocationId },
    });
  });

  it("refuses an intent against a read-only edge AT THE ORIGIN, not merely in the UI", async () => {
    const origin = makeSide(`ada-ro-${crypto.randomUUID().slice(0, 8)}`);
    const audience = makeSide(`priya-ro-${crypto.randomUUID().slice(0, 8)}`);
    await link(origin, audience);
    const { edge } = await lend(origin, audience, borrowedSlotsFor(audience), {
      edgeId: "edge-read-only",
      itemType: "schedule.task",
      scopes: WRITE_SCOPE,
      verbs: "read",
    });
    expect(edge.status).toBe("established");

    const request = requestForEdge(edge.edge_id, "intent-denied-1", {
      action: "schedule.add_task",
      input: { title: "Should never land" },
    });
    const result = await pushLendIntentOverPeer({
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      edgeId: edge.edge_id,
      request,
    });
    expect(result.state).toBe("answered");
    if (result.state !== "answered") throw new Error("unreachable");
    expect(result.frame.state).toBe("denied");
    expect(taskCount(origin)).toBe(0);

    // The refusal came from the ORDINARY consent chain (readonly-device
    // deny), receipted like any other denial — not a route guard that
    // merely hides the action from a UI.
    const denyReceipts = origin.vault.journal
      .prepare(
        "SELECT decision FROM consent_receipt WHERE action = 'act schedule.add_task' AND decision = 'deny'"
      )
      .all() as Array<{ decision: string }>;
    expect(denyReceipts.length).toBeGreaterThanOrEqual(1);
  });
});
