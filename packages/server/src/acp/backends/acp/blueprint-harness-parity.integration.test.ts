/**
 * Native-blueprint harness parity (#630).
 *
 * This owns the model-facing carrier: a real ACP subprocess discovers the
 * per-turn loopback MCP server, calls `vault_invoke` once for every native
 * blueprint, and relays the harness's consent outcome and receipt unchanged.
 * Command semantics and journal durability stay owned by each vault command's
 * integration tests; duplicating the vault engine here would turn this into a
 * second, weaker command test.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { VaultInvokeRunner } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { runFake, types, vaultToolContext } from "./test-fixtures.js";

const expectedCommands = [
  ["photos", "media.create_album"],
  ["docs", "core.create_folder"],
  ["agenda", "schedule.propose_event"],
  ["tasks", "schedule.add_task"],
  ["people", "people.add_person"],
  ["notes", "knowledge.create_note"],
  ["tally", "tally.create_group"],
  ["locker", "locker.purge_item"],
] as const;

interface InvocationProbe {
  blueprint: string;
  command: string;
  isError: boolean | null;
  text: string | null;
}

interface ParityProbe {
  sawServer: boolean;
  tools: string[];
  invocations: InvocationProbe[];
}

describe("native blueprint harness parity", () => {
  test("ACP drives all eight blueprints through consented vault_invoke receipts", async () => {
    const dir = await tempDir("acp-blueprint-parity-");
    const vaultMarker = path.join(dir, "vault");
    const calls: Parameters<VaultInvokeRunner>[0][] = [];
    const receipts: Array<{
      command: string;
      decision: "allow" | "park";
      receiptId: string;
    }> = [];

    const vaultInvoke: VaultInvokeRunner = (call) => {
      calls.push(call);
      const index = calls.length - 1;
      const expected = expectedCommands[index];
      if (!expected || call.command !== expected[1])
        throw new Error(`unexpected parity command ${call.command}`);

      const parked = call.command === "locker.purge_item";
      const receiptId = `receipt-harness-parity-${expected[0]}`;
      receipts.push({
        command: call.command,
        decision: parked ? "park" : "allow",
        receiptId,
      });
      return {
        status: parked ? "parked" : "executed",
        invocationId: `invocation-harness-parity-${expected[0]}`,
        receiptId,
        ...(parked
          ? { reason: "owner confirmation required for permanent purge" }
          : { output: { blueprint: expected[0] } }),
      };
    };

    const { events, result } = await runFake({
      extraArgs: [
        "--mode=vault-parity",
        "--mcp-http",
        `--vault-marker=${vaultMarker}`,
      ],
      toolContext: vaultToolContext({ vaultInvoke }),
    });

    expect(result.sessionId).toBeTruthy();
    expect(calls.map((call) => call.command)).toStrictEqual(
      expectedCommands.map(([, command]) => command)
    );
    expect(calls.every((call) => Object.keys(call.input).length > 0)).toBe(
      true
    );

    const probe = JSON.parse(
      await fs.readFile(vaultMarker, "utf8")
    ) as ParityProbe;
    expect(probe.sawServer).toBe(true);
    expect(probe.tools).toContain("vault_invoke");
    expect(
      probe.invocations.map(({ blueprint, command }) => [blueprint, command])
    ).toStrictEqual(expectedCommands);
    expect(probe.invocations.every(({ isError }) => isError === false)).toBe(
      true
    );

    const outcomes = probe.invocations.map(({ text }) =>
      JSON.parse(String(text))
    ) as Array<{ status: string; receiptId: string }>;
    expect(
      outcomes.slice(0, -1).every(({ status }) => status === "executed")
    ).toBe(true);
    expect(outcomes.at(-1)?.status).toBe("parked");
    expect(outcomes.map(({ receiptId }) => receiptId)).toStrictEqual(
      receipts.map(({ receiptId }) => receiptId)
    );
    expect(receipts).toHaveLength(expectedCommands.length);
    expect(receipts.at(-1)?.decision).toBe("park");

    expect(
      events.filter(
        (event) =>
          event.type === "tool.start" && event.toolName === "vault_invoke"
      )
    ).toHaveLength(expectedCommands.length);
    expect(
      events.filter(
        (event) =>
          event.type === "tool.result" && event.toolName === "vault_invoke"
      )
    ).toHaveLength(expectedCommands.length);
    expect(types(events).at(-1)).toBe("final");
  });
});
