/*
 * WHAT IDENTIFIES ONE OF A REPLAYED INTENT'S CALLS (#1014, B4).
 *
 * The invocation id was `sha256([tag, intentId, ordinal])` over whichever
 * invokes the handler happened to make on THIS run. A handler that branches on
 * vault state makes a different sequence on the replay — `notes/actions/
 * send-to-tasks.ts` issues two, the second best-effort and swallowed — so the
 * position is not a property of the call, and shifted positions make a replay
 * match the wrong retained receipt or trip `assertInvocationIdentity`.
 */

import crypto from "node:crypto";

import { describe, expect, test } from "vitest";

import { bindIntentToVaultBridge } from "./dispatcher.js";
import type { VaultBridge } from "./vault-bridge.js";

function recorder(): {
  bridge: VaultBridge;
  seen: Record<string, unknown>[];
} {
  const seen: Record<string, unknown>[] = [];
  const bridge: VaultBridge = (call) => {
    seen.push(call.payload);
    return Promise.resolve({ ok: true, result: {} } as never);
  };
  return { bridge, seen };
}

const ordinalId = (intentId: string, ordinal: number): string =>
  `replica:v1:${crypto
    .createHash("sha256")
    .update(
      JSON.stringify(["centraid.replica-invocation.v1", intentId, ordinal])
    )
    .digest("hex")}`;

describe("an intent-bound vault bridge", () => {
  test("keeps the ordinal form byte-identical when no key is declared", async () => {
    const { bridge, seen } = recorder();
    const bound = bindIntentToVaultBridge(bridge, "intent-1");
    await bound({ op: "invoke", payload: { command: "schedule.add_task" } });
    await bound({ op: "invoke", payload: { command: "core.link_entities" } });
    // An intent already in flight keeps the ids its half-finished replay is
    // looking for.
    expect(seen[0]?.invocationId).toBe(ordinalId("intent-1", 0));
    expect(seen[1]?.invocationId).toBe(ordinalId("intent-1", 1));
  });

  test("a declared key names the call, whatever position it lands in", async () => {
    const first = recorder();
    const boundFirst = bindIntentToVaultBridge(first.bridge, "intent-2");
    await boundFirst({
      op: "invoke",
      payload: { command: "schedule.add_task" },
    });
    await boundFirst({
      op: "invoke",
      payload: { command: "core.link_entities", invokeKey: "backlink" },
    });

    // The replay takes the other branch: the keyed call is now FIRST.
    const second = recorder();
    const boundSecond = bindIntentToVaultBridge(second.bridge, "intent-2");
    await boundSecond({
      op: "invoke",
      payload: { command: "core.link_entities", invokeKey: "backlink" },
    });

    expect(second.seen[0]?.invocationId).toBe(first.seen[1]?.invocationId);
    // …and it is NOT the id the task's own call holds, which is exactly the
    // collision the ordinal produced.
    expect(second.seen[0]?.invocationId).not.toBe(first.seen[0]?.invocationId);
  });

  test("the key is a directive to the bridge and never reaches the command", async () => {
    const { bridge, seen } = recorder();
    const bound = bindIntentToVaultBridge(bridge, "intent-3");
    await bound({
      op: "invoke",
      payload: { command: "core.link_entities", invokeKey: "backlink" },
    });
    expect(seen[0]).not.toHaveProperty("invokeKey");
    expect(seen[0]?.command).toBe("core.link_entities");
  });

  test("a key cannot collide across two intents", async () => {
    const left = recorder();
    const right = recorder();
    await bindIntentToVaultBridge(
      left.bridge,
      "intent-a"
    )({
      op: "invoke",
      payload: { command: "x", invokeKey: "same" },
    });
    await bindIntentToVaultBridge(
      right.bridge,
      "intent-b"
    )({
      op: "invoke",
      payload: { command: "x", invokeKey: "same" },
    });
    expect(left.seen[0]?.invocationId).not.toBe(right.seen[0]?.invocationId);
  });
});
