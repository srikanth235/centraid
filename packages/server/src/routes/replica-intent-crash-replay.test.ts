// The offline-intent commit path, crash boundary by crash boundary (#922 B8).
//
// Every durable transaction on the path gets a case: the process is stopped
// where that transaction's commit either happened or did not, the vault is
// REOPENED FROM DISK, and the same intent is resubmitted. Convergence is the
// assertion in all of them — one write, one terminal outcome, one receipt —
// so the suite holds whether the path pays three durable commits or two, and
// is what a fold of those commits has to keep green.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { handleReplicaIntent } from "./replica-intent-route.js";
import type {
  ReplicaIntentDispatchOutcome,
  ReplicaIntentDispatcher,
} from "./replica-intent-route.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const DEVICE_ID = "device-crash-replay";
const APP_ID = "planner";
const ACTION = "add_task";

const cleanups: Array<() => Promise<void> | void> = [];

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function intentBody(intentId: string, title: string) {
  const input = { title };
  return {
    intentId,
    appId: APP_ID,
    action: ACTION,
    input,
    payloadHash: crypto
      .createHash("sha256")
      .update(canonicalJson({ action: ACTION, appId: APP_ID, input }))
      .digest("hex"),
  };
}

/** The id the engine's intent-bound bridge mints: intent + call ordinal, so a
 *  redelivered intent replays instead of re-executing. */
function replicaInvocationId(intentId: string, ordinal: number): string {
  return `replica:v1:${crypto
    .createHash("sha256")
    .update(
      JSON.stringify(["centraid.replica-invocation.v1", intentId, ordinal])
    )
    .digest("hex")}`;
}

function request(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    headers: {},
    method: "POST",
    url: "/centraid/_vault/replica/intents",
  }) as unknown as IncomingMessage;
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

describe("replica intent crash replay", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function vaultDir(): Promise<string> {
    const dir = await tempDir(`intent-crash-${crypto.randomUUID()}-`);
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  /** A gateway process over an existing vault directory: `stop()` is the crash. */
  function boot(dir: string): VaultPlane {
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(() => plane.stop());
    return plane;
  }

  /** The action handler's write, through the plane's group-commit queue. */
  function dispatcherFor(
    plane: VaultPlane,
    after: "return" | "crash" = "return"
  ): ReplicaIntentDispatcher {
    return async (input): Promise<ReplicaIntentDispatchOutcome> => {
      const outcome = await plane.invoke(plane.ownerCredential, {
        command: "schedule.add_task",
        input: input.input as Record<string, unknown>,
        purpose: "dpv:ServiceProvision",
        invocationId: replicaInvocationId(input.intentId, 0),
        intentId: input.intentId,
        intentDeviceId: DEVICE_ID,
      });
      if (after === "crash") {
        throw new Error("the process died after the canonical commit");
      }
      return outcome.status === "executed" || outcome.status === "replayed"
        ? {
            status: "executed",
            ...(outcome.output ? { output: outcome.output } : {}),
          }
        : { status: "failed", reason: "unexpected outcome" };
    };
  }

  async function submit(
    plane: VaultPlane,
    dispatch: ReplicaIntentDispatcher,
    body: ReturnType<typeof intentBody>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const result = response();
    await handleReplicaIntent(request(body), result.res, {
      plane,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId: DEVICE_ID,
        appId: APP_ID,
      },
      dispatch,
    });
    return { status: result.res.statusCode, body: result.body() };
  }

  function tasksTitled(plane: VaultPlane, title: string): number {
    return (
      plane.db.vault
        .prepare("SELECT COUNT(*) AS n FROM schedule_task WHERE title = ?")
        .get(title) as { n: number }
    ).n;
  }

  function intentRow(
    plane: VaultPlane,
    intentId: string
  ): { status: string; invocation_id: string | null } | undefined {
    return plane.db.vault
      .prepare(
        "SELECT status, invocation_id FROM replica_intent_outcome WHERE intent_id = ?"
      )
      .get(intentId) as
      | { status: string; invocation_id: string | null }
      | undefined;
  }

  function unfinishedMarkers(plane: VaultPlane, intentId: string): number {
    return (
      plane.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM replica_invocation_commit WHERE intent_id = ?"
        )
        .get(intentId) as { n: number }
    ).n;
  }

  function auditTrail(
    plane: VaultPlane,
    invocationId: string
  ): { status: string; receipts: number } {
    const invocation = plane.db.vault
      .prepare(
        "SELECT status FROM agent_command_invocation WHERE invocation_id = ?"
      )
      .get(invocationId) as { status: string } | undefined;
    const receipts = (
      plane.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM access_receipt WHERE invocation_id = ?"
        )
        .get(invocationId) as { n: number }
    ).n;
    return { status: invocation?.status ?? "missing", receipts };
  }

  test("a crash before admission leaves nothing, and the redelivered intent executes exactly once", async () => {
    const dir = await vaultDir();
    const intentId = "intent-crash-pre-admission";
    const title = "before admission";
    const first = boot(dir);
    // The request never reached the admission commit.
    expect(intentRow(first, intentId)).toBeUndefined();
    first.stop();

    const restarted = boot(dir);
    const replay = await submit(
      restarted,
      dispatcherFor(restarted),
      intentBody(intentId, title)
    );

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ outcome: { status: "executed" } });
    expect(tasksTitled(restarted, title)).toBe(1);
    expect(intentRow(restarted, intentId)?.status).toBe("executed");
    expect(unfinishedMarkers(restarted, intentId)).toBe(0);
  });

  test("a crash after admission and before the canonical commit replays into exactly one write", async () => {
    const dir = await vaultDir();
    const intentId = "intent-crash-mid-dispatch";
    const title = "mid dispatch";
    const body = intentBody(intentId, title);
    const first = boot(dir);
    const dying = vi
      .fn<ReplicaIntentDispatcher>()
      .mockRejectedValue(
        new Error("the process died before the canonical commit")
      );
    const ambiguous = await submit(first, dying, body);
    expect(ambiguous.status).toBe(202);
    expect(intentRow(first, intentId)?.status).toBe("sending");
    expect(tasksTitled(first, title)).toBe(0);
    first.stop();

    const restarted = boot(dir);
    // The admission row survived the crash and still names the same intent.
    expect(intentRow(restarted, intentId)?.status).toBe("sending");
    const replay = await submit(restarted, dispatcherFor(restarted), body);

    expect(replay.status).toBe(200);
    expect(tasksTitled(restarted, title)).toBe(1);
    expect(intentRow(restarted, intentId)?.status).toBe("executed");
    expect(unfinishedMarkers(restarted, intentId)).toBe(0);
  });

  test("a crash after the canonical commit never re-executes the command and converges on reopen", async () => {
    const dir = await vaultDir();
    const intentId = "intent-crash-post-commit";
    const title = "post commit";
    const body = intentBody(intentId, title);
    const invocationId = replicaInvocationId(intentId, 0);
    const first = boot(dir);
    await submit(first, dispatcherFor(first, "crash"), body);
    // The write crossed the canonical boundary before the process died.
    expect(tasksTitled(first, title)).toBe(1);
    first.stop();

    const restarted = boot(dir);
    expect(tasksTitled(restarted, title)).toBe(1);
    const dispatch = vi.fn<ReplicaIntentDispatcher>(dispatcherFor(restarted));
    const replay = await submit(restarted, dispatch, body);

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ outcome: { status: "executed" } });
    // Whether the redelivery is answered from the outcome row or from the
    // invocation replay, the command runs once and only once.
    expect(tasksTitled(restarted, title)).toBe(1);
    expect(intentRow(restarted, intentId)?.status).toBe("executed");
    expect(unfinishedMarkers(restarted, intentId)).toBe(0);
    expect(auditTrail(restarted, invocationId)).toStrictEqual({
      status: "executed",
      receipts: 1,
    });
  });

  test("a committed intent leaves no repairable state, and its receipt is neither duplicated nor lost by redelivery", async () => {
    const dir = await vaultDir();
    const intentId = "intent-clean-commit";
    const title = "clean commit";
    const body = intentBody(intentId, title);
    const invocationId = replicaInvocationId(intentId, 0);
    const plane = boot(dir);
    const dispatch = vi.fn<ReplicaIntentDispatcher>(dispatcherFor(plane));
    const executed = await submit(plane, dispatch, body);

    expect(executed.status).toBe(200);
    // The write, its journal rows and the device-visible outcome are durable
    // together: no marker is left for startup repair to finish.
    expect(unfinishedMarkers(plane, intentId)).toBe(0);
    expect(auditTrail(plane, invocationId)).toStrictEqual({
      status: "executed",
      receipts: 1,
    });

    const redelivered = await submit(plane, dispatch, body);
    expect(redelivered.status).toBe(200);
    expect(redelivered.body).toMatchObject({ outcome: { status: "executed" } });
    expect(tasksTitled(plane, title)).toBe(1);
    expect(auditTrail(plane, invocationId)).toStrictEqual({
      status: "executed",
      receipts: 1,
    });

    plane.stop();
    const restarted = boot(dir);
    // Reopen is fail-closed on unfinished markers; a clean commit reopens.
    expect(tasksTitled(restarted, title)).toBe(1);
    expect(auditTrail(restarted, invocationId)).toStrictEqual({
      status: "executed",
      receipts: 1,
    });
  });
});
