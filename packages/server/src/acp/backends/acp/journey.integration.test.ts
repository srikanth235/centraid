import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { deltas, runFake, types, vaultToolContext } from "./test-fixtures.js";

describe("journey", () => {
  test("chat journey: user message yields vault side effect and visible transcript events", async () => {
    const dir = await tempDir("acp-journey-");
    const vaultMarker = path.join(dir, "vault");
    const ctx = vaultToolContext();

    const { events, result } = await runFake({
      extraArgs: [
        "--mode=vault",
        "--mcp-http",
        `--vault-marker=${vaultMarker}`,
      ],
      toolContext: ctx,
    });

    expect(result.sessionId).toBeTruthy();

    expect(ctx.calls.length).toBeGreaterThanOrEqual(1);
    expect(ctx.calls[0]?.sql).toBe("SELECT 1");

    const t = types(events);
    expect(t).toContain("tool.start");
    expect(t).toContain("tool.result");
    expect(t).toContain("final");
    expect(t.at(-1)).toBe("final");

    const toolStart = events.find((e) => e.type === "tool.start");
    expect(
      toolStart && toolStart.type === "tool.start" && toolStart.toolName
    ).toBe("vault_sql");
    const toolResult = events.find((e) => e.type === "tool.result");
    expect(
      toolResult && toolResult.type === "tool.result" && toolResult.ok
    ).toBe(true);

    const probe = JSON.parse(await fs.readFile(vaultMarker, "utf8")) as {
      callIsError?: boolean | null;
    };
    expect(probe.callIsError).toBe(false);
    const final = events.find((e) => e.type === "final");
    const spoken =
      deltas(events) || (final && final.type === "final" ? final.text : "");
    expect(spoken).toBeTypeOf("string");
  });

  test("chat journey: resume reuses session and does not leak history into transcript", async () => {
    const { events, result } = await runFake({
      extraArgs: ["--mode=resume"],
      prevSessionId: "journey-sess",
    });
    expect(result.sessionId).toBe("journey-sess");
    const allText = JSON.stringify(events);
    expect(allText).not.toContain("HISTORY_USER");
    expect(allText).not.toContain("HISTORY_AGENT");
    expect(types(events).at(-1)).toBe("final");
  });
});
