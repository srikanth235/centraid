/**
 * The action kit is the ONE implementation of the refusal taxonomy every
 * bundled write settles into, so these cases pin the WIRE bytes rather than
 * the object: `reason`/`code` are set unconditionally, and JSON drops an
 * undefined value, which is what a client actually receives.
 */
import { describe, expect, it } from "vitest";

import { actionInput, deniedResult, runVaultAction } from "./action-kit.ts";

type Ctx = Parameters<typeof runVaultAction>[0];

function throwingCtx(error: unknown): Ctx {
  return {
    vault: {
      invoke: async () => {
        throw error;
      },
    },
  } as unknown as Ctx;
}

function recordingCtx(outcome: Record<string, unknown>) {
  const seen: Record<string, unknown>[] = [];
  const ctx = {
    vault: {
      invoke: async (request: Record<string, unknown>) => {
        seen.push(request);
        return outcome;
      },
    },
  } as unknown as Ctx;
  return { ctx, seen };
}

describe("the shared vault-action run", () => {
  it("passes the outcome through verbatim under the app purpose", async () => {
    const { ctx, seen } = recordingCtx({
      status: "parked",
      invocationId: "i1",
    });
    const result = await runVaultAction(ctx, {
      command: "schedule.add_task",
      input: { title: "Ship it" },
    });
    expect(seen).toStrictEqual([
      {
        command: "schedule.add_task",
        input: { title: "Ship it" },
      },
    ]);
    expect(result).toStrictEqual({
      status: 200,
      body: { status: "parked", invocationId: "i1" },
    });
  });

  it("turns a thrown refusal into a 200 denial carrying reason and code", async () => {
    const error = Object.assign(new Error("no consent"), {
      code: "VAULT_ACCESS",
    });
    const result = await runVaultAction(throwingCtx(error), {
      command: "schedule.add_task",
      input: {},
    });
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toBe(
      '{"status":"denied","reason":"no consent","code":"VAULT_ACCESS"}'
    );
  });

  it("omits the keys it has no value for, rather than sending null", async () => {
    const bare = await runVaultAction(throwingCtx(new Error("bare")), {
      command: "core.detach",
      input: {},
    });
    expect(JSON.stringify(bare.body)).toBe(
      '{"status":"denied","reason":"bare"}'
    );
    const opaque = await runVaultAction(throwingCtx({}), {
      command: "core.detach",
      input: {},
    });
    expect(JSON.stringify(opaque.body)).toBe('{"status":"denied"}');
  });

  it("runs `settle` after the command and before answering", async () => {
    const { ctx } = recordingCtx({ status: "executed", output: { id: "x" } });
    const order: string[] = [];
    const result = await runVaultAction(
      ctx,
      { command: "schedule.add_task", input: {} },
      async (outcome) => {
        order.push(String(outcome.status));
      }
    );
    expect(order).toStrictEqual(["executed"]);
    expect(result.body).toStrictEqual({
      status: "executed",
      output: { id: "x" },
    });
  });

  it("answers as a denial when `settle` throws — best effort swallows its own", async () => {
    const { ctx } = recordingCtx({ status: "executed" });
    const result = await runVaultAction(
      ctx,
      { command: "schedule.add_task", input: {} },
      async () => {
        throw new Error("backlink failed");
      }
    );
    expect(result.body).toStrictEqual({
      status: "denied",
      reason: "backlink failed",
      code: undefined,
    });
  });
});

describe("a handler-side refusal and its body bag", () => {
  it("shapes a handler-side refusal like a thrown one", () => {
    expect(JSON.stringify(deniedResult("A task needs a title.").body)).toBe(
      '{"status":"denied","reason":"A task needs a title."}'
    );
    expect(deniedResult("gone", "NOT_FOUND").body).toStrictEqual({
      status: "denied",
      reason: "gone",
      code: "NOT_FOUND",
    });
  });

  it("reads a missing body as an empty bag", () => {
    expect(actionInput(undefined)).toStrictEqual({});
    expect(actionInput(null)).toStrictEqual({});
    expect(actionInput({ task_id: "t1" })).toStrictEqual({ task_id: "t1" });
  });
});
