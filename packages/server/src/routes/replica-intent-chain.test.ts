// THE OFFLINE CHAIN, AT THE ROUTE (#996, rulings R23–R25).
//
// Five intents queued on a phone in airplane mode — create, rename, rename,
// due date, complete — arrive as five separate admissions, each naming the
// ones before it and referring to a row that DID NOT EXIST when it was
// written. What this suite asserts is that the gateway is the thing that
// makes that chain causal: order, substitution, and what happens when a
// predecessor never lands.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { plainSqliteRow, plainSqliteRows } from "@centraid/test-kit/sqlite";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
} from "@centraid/vault";

import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { handleReplicaIntent } from "./replica-intent-route.js";
import type { ReplicaIntentDispatcher } from "./replica-intent-route.js";
import { expectedPayloadHash } from "./replica-intent-shape.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

interface Submission {
  intentId: string;
  action: string;
  input: unknown;
  dependsOn?: string[];
  baseVersions?: {
    entity: string;
    rowId: string;
    version: number;
  }[];
}

describe("the offline chain", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function plane(): Promise<VaultPlane> {
    const dir = await tempDir(`replica-chain-${crypto.randomUUID()}-`);
    const opened = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => opened.stop()
    );
    opened.recordAppInstall("planner", {
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    return opened;
  }

  function response(): {
    res: ServerResponse;
    body: () => Record<string, unknown>;
  } {
    let output = "";
    const res = {
      statusCode: 0,
      setHeader: vi.fn<ServerResponse["setHeader"]>(),
      end: (value?: string) => {
        output = value ?? "";
      },
    } as unknown as ServerResponse;
    return { res, body: () => JSON.parse(output) as Record<string, unknown> };
  }

  /**
   * A dispatcher that RUNS THE REAL COMMAND. Nothing about this suite works
   * against a stub: `commit_seq` and the produced set are stamped inside the
   * canonical transaction, and the whole question is whether the substituted
   * row id addresses the row the create actually made.
   */
  function dispatcherFor(vault: VaultPlane): ReplicaIntentDispatcher {
    return async (request) => {
      const bridge = vault.bridgeFor(request.appId);
      const result = await bridge({
        op: "invoke",
        payload: { command: request.action, input: request.input },
      });
      if (!result.ok)
        return { status: "denied", reason: result.error ?? "refused" };
      const body = result.result as { status?: string; reason?: string };
      if (body?.status === "executed" || body?.status === undefined)
        return { status: "executed", output: body };
      if (body.status === "parked") return { status: "parked" };
      return {
        status: "denied",
        reason: body.reason ?? "the vault refused it",
      };
    };
  }

  async function submit(
    vault: VaultPlane,
    dispatch: ReplicaIntentDispatcher,
    submission: Submission,
    deviceId = "device-phone"
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const baseVersions = submission.baseVersions ?? [];
    const dependsOn = submission.dependsOn ?? [];
    const body = {
      intentId: submission.intentId,
      appId: "planner",
      action: submission.action,
      input: submission.input,
      ...(baseVersions.length > 0 ? { baseVersions } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      payloadHash: expectedPayloadHash(
        "planner",
        submission.action,
        submission.input,
        baseVersions,
        [...dependsOn].sort()
      ),
    };
    const req = Object.assign(Readable.from([JSON.stringify(body)]), {
      headers: {},
      method: "POST",
      url: "/centraid/_vault/replica/intents",
    }) as unknown as IncomingMessage;
    const result = response();
    await handleReplicaIntent(req, result.res, {
      plane: vault,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId,
        appId: "planner",
      },
      dispatch,
    });
    return { status: result.res.statusCode, body: result.body() };
  }

  const CREATE = "chain-create";
  const RENAME_ONE = "chain-rename-1";
  const RENAME_TWO = "chain-rename-2";
  const DUE = "chain-due";
  const COMPLETE = "chain-complete";

  const ref = { $intent: CREATE, table: "schedule_task" };

  function chain(): Submission[] {
    return [
      {
        intentId: CREATE,
        action: "schedule.add_task",
        input: { title: "draft the brief" },
      },
      {
        intentId: RENAME_ONE,
        action: "schedule.edit_task",
        input: { task_id: ref, title: "draft the brief, properly" },
        dependsOn: [CREATE],
      },
      {
        intentId: RENAME_TWO,
        action: "schedule.edit_task",
        input: { task_id: ref, title: "the brief" },
        dependsOn: [CREATE, RENAME_ONE],
      },
      {
        intentId: DUE,
        action: "schedule.edit_task",
        input: { task_id: ref, due_at: "2026-10-01T09:00:00.000Z" },
        dependsOn: [CREATE, RENAME_TWO],
      },
      {
        intentId: COMPLETE,
        action: "schedule.set_task_status",
        input: { task_id: ref, status: "completed" },
        dependsOn: [CREATE, DUE],
      },
    ];
  }

  function taskIdOf(vault: VaultPlane, intentId: string): string {
    const outcome = readReplicaIntentOutcome(
      vault.db.vault,
      intentId,
      "device-phone"
    );
    const produced = (outcome?.produced ?? []).find(
      (row) => row.table === "schedule_task"
    );
    return String(produced?.pk[0] ?? "");
  }

  test("five queued intents execute in order, each resolving the row the create made", async () => {
    const vault = await plane();
    const dispatch = dispatcherFor(vault);
    const answers: Record<string, Record<string, unknown>> = {};
    await forEachSequentially(chain(), async (submission) => {
      const answer = await submit(vault, dispatch, submission);
      answers[submission.intentId] = answer.body;
    });

    for (const id of [CREATE, RENAME_ONE, RENAME_TWO, DUE, COMPLETE]) {
      const outcome = readReplicaIntentOutcome(
        vault.db.vault,
        id,
        "device-phone"
      );
      expect(`${id}:${outcome?.status}`).toBe(`${id}:executed`);
      // R24: every executed outcome knows WHERE it landed, and what landed.
      expect(outcome?.commitSeq).toBeTypeOf("number");
      expect((outcome?.produced ?? []).length).toBeGreaterThan(0);
    }

    // Five intents, five DISTINCT commits — the chain is not one transaction
    // the gateway quietly merged.
    const positions = [CREATE, RENAME_ONE, RENAME_TWO, DUE, COMPLETE].map(
      (id) =>
        readReplicaIntentOutcome(vault.db.vault, id, "device-phone")?.commitSeq
    );
    expect(new Set(positions).size).toBe(5);
    expect([...positions].sort((a, b) => Number(a) - Number(b))).toStrictEqual(
      positions
    );

    // ONE task, with the LAST value of every field the chain set.
    const taskId = taskIdOf(vault, CREATE);
    expect(taskId).not.toBe("");
    const tasks = plainSqliteRows(
      vault.db.vault
        .prepare(`SELECT task_id, title, due_at, status FROM schedule_task`)
        .all()
    ) as {
      task_id: string;
      title: string;
      due_at: string | null;
      status: string;
    }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task_id).toBe(taskId);
    expect(tasks[0]?.title).toBe("the brief");
    expect(tasks[0]?.due_at).toBe("2026-10-01T09:00:00.000Z");
    expect(tasks[0]?.status).toBe("completed");

    // Each dependent's produced set names the SAME row the create produced —
    // which is the substitution having happened, not a second task.
    for (const id of [RENAME_ONE, RENAME_TWO, DUE, COMPLETE])
      expect(`${id}:${taskIdOf(vault, id)}`).toBe(`${id}:${taskId}`);
  });

  test("an intent arriving before its predecessor parks naming it, and releases when the predecessor lands", async () => {
    const vault = await plane();
    const dispatch = vi.fn<ReplicaIntentDispatcher>(dispatcherFor(vault));
    const [create, rename] = chain();

    // The rename arrives first — an outbox draining out of order, or a
    // retry of the second intent while the first is still in flight.
    const early = await submit(vault, dispatch, rename!);
    expect(early.status).toBe(202);
    expect(early.body.outcome).toMatchObject({
      status: "parked",
      waitingOn: { seat: "intent", label: CREATE },
    });
    expect(dispatch).not.toHaveBeenCalled();

    await submit(vault, dispatch, create!);
    // The parked intent is retained, so its retry runs rather than starting
    // over: same id, same payload, now admissible.
    const released = await submit(vault, dispatch, rename!);
    expect(released.status).toBe(200);
    expect(released.body.outcome).toMatchObject({ status: "executed" });
    expect(taskIdOf(vault, RENAME_ONE)).toBe(taskIdOf(vault, CREATE));
  });

  test("a denied create parks its dependents with the reason that names it, and no dependent executes", async () => {
    const vault = await plane();
    const dispatch = dispatcherFor(vault);
    const [create, rename, renameTwo] = chain();

    // The create is refused at the gateway: a task cannot be its own parent.
    const denied = await submit(vault, dispatch, {
      ...create!,
      input: { title: "" },
    });
    expect(denied.body.outcome).toMatchObject({ status: "denied" });

    await forEachSequentially([rename!, renameTwo!], async (submission) => {
      const answer = await submit(vault, dispatch, submission);
      expect(answer.status).toBe(202);
      expect(answer.body.outcome).toMatchObject({
        status: "parked",
        waitingOn: { seat: "intent", label: CREATE },
      });
    });
    // Nothing ran: no task, and no substitution against a row that never was.
    expect(
      plainSqliteRow(
        vault.db.vault.prepare(`SELECT count(*) AS n FROM schedule_task`).get()
      )
    ).toStrictEqual({ n: 0 });
  });

  test("another device's edit between two dependents conflicts exactly once, and the dependents behind it park", async () => {
    const vault = await plane();
    const dispatch = dispatcherFor(vault);
    const [create, rename, renameTwo, due] = chain();
    await submit(vault, dispatch, create!);
    await submit(vault, dispatch, rename!);
    const taskId = taskIdOf(vault, CREATE);

    // The version the phone last observed, before the other device writes.
    const observed = (
      vault.db.vault
        .prepare(`SELECT row_version AS v FROM schedule_task WHERE task_id = ?`)
        .get(taskId) as { v: number }
    ).v;

    // ANOTHER DEVICE edits the same task.
    await submit(
      vault,
      dispatch,
      {
        intentId: "other-device-edit",
        action: "schedule.edit_task",
        input: { task_id: taskId, title: "renamed on the laptop" },
      },
      "device-laptop"
    );
    const moved = (
      vault.db.vault
        .prepare(`SELECT row_version AS v FROM schedule_task WHERE task_id = ?`)
        .get(taskId) as { v: number }
    ).v;
    expect(moved).toBeGreaterThan(observed);

    // The next intent in the chain still carries the version the phone saw.
    const stale = await submit(vault, dispatch, {
      ...renameTwo!,
      baseVersions: [
        { entity: "schedule.task", rowId: taskId, version: observed },
      ],
    });
    expect(stale.body.outcome).toMatchObject({
      status: "conflict",
      conflict: {
        entity: "schedule.task",
        rowId: taskId,
        expectedVersion: observed,
        actualVersion: moved,
      },
    });

    // EXACTLY ONE conflict: the dependent behind it does not conflict a
    // second time on the same fact, it parks naming the intent that did.
    const dependent = await submit(vault, dispatch, {
      ...due!,
      dependsOn: [CREATE, RENAME_TWO],
    });
    expect(dependent.status).toBe(202);
    expect(dependent.body.outcome).toMatchObject({
      status: "parked",
      waitingOn: { seat: "intent", label: RENAME_TWO },
    });
    const conflicts = [CREATE, RENAME_ONE, RENAME_TWO, DUE].filter(
      (id) =>
        readReplicaIntentOutcome(vault.db.vault, id, "device-phone")?.status ===
        "conflict"
    );
    expect(conflicts).toStrictEqual([RENAME_TWO]);

    // The laptop's title stands — the stale rename never landed.
    expect(
      plainSqliteRow(
        vault.db.vault
          .prepare(`SELECT title FROM schedule_task WHERE task_id = ?`)
          .get(taskId)
      )
    ).toStrictEqual({ title: "renamed on the laptop" });
  });

  test("a lost acknowledgement replays the retained outcome; a changed payload under the same id is refused", async () => {
    const vault = await plane();
    const dispatch = vi.fn<ReplicaIntentDispatcher>(dispatcherFor(vault));
    const [create] = chain();
    const first = await submit(vault, dispatch, create!);
    expect(first.body.outcome).toMatchObject({ status: "executed" });
    const commitSeq = readReplicaIntentOutcome(
      vault.db.vault,
      CREATE,
      "device-phone"
    )?.commitSeq;
    const calls = dispatch.mock.calls.length;

    // THE ACK WAS LOST, so the phone sends the very same intent again.
    const replay = await submit(vault, dispatch, create!);
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toMatchObject({
      status: "executed",
      commitSeq,
    });
    expect(dispatch).toHaveBeenCalledTimes(calls);
    expect(
      plainSqliteRow(
        vault.db.vault.prepare(`SELECT count(*) AS n FROM schedule_task`).get()
      )
    ).toStrictEqual({ n: 1 });

    // The SAME id with a DIFFERENT payload is a different operation.
    const changed = await submit(vault, dispatch, {
      ...create!,
      input: { title: "something else entirely" },
    });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({
      error: "replica_intent_payload_mismatch",
    });
    expect(dispatch).toHaveBeenCalledTimes(calls);
  });

  test("an outcome past its idempotency window answers unknown-recover, never a second execution", async () => {
    const vault = await plane();
    const dispatch = vi.fn<ReplicaIntentDispatcher>(dispatcherFor(vault));
    const [create] = chain();
    await submit(vault, dispatch, create!);
    const calls = dispatch.mock.calls.length;

    // Age the retained answer out of the window.
    recordReplicaIntentOutcome(vault.db.vault, {
      intentId: CREATE,
      deviceId: "device-phone",
      appId: "planner",
      action: "schedule.add_task",
      payloadHash: readReplicaIntentOutcome(
        vault.db.vault,
        CREATE,
        "device-phone"
      )!.payloadHash,
      status: "executed",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const late = await submit(vault, dispatch, create!);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({
      error: "replica_intent_outcome_expired",
      intentId: CREATE,
      recovery: "resubmit-as-new-intent",
    });
    // The point of the answer: it did NOT run again.
    expect(dispatch).toHaveBeenCalledTimes(calls);
    expect(
      plainSqliteRow(
        vault.db.vault.prepare(`SELECT count(*) AS n FROM schedule_task`).get()
      )
    ).toStrictEqual({ n: 1 });
  });
});
