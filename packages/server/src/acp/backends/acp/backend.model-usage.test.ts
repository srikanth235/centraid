// Model pinning via `session/set_config_option` and the end-of-turn `usage`
// event it stamps.

import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { notices, runFake, usageOf } from "./test-fixtures.js";

describe("backend.model-usage suite", () => {
  test("a pinned model is selected through session/set_config_option", async () => {
    const dir = await tempDir("acp-model-");
    const configMarker = path.join(dir, "config");
    const { events } = await runFake({
      extraArgs: ["--mode=normal", `--config-marker=${configMarker}`],
      model: "fake-opus-9-1",
    });

    await expect(fs.readFile(configMarker, "utf8")).resolves.toBe(
      "model=fake-opus-9-1"
    );
    // A successful pin is silent.
    expect(notices(events)).not.toContain("model_unsupported");
    expect(notices(events)).not.toContain("model_not_offered");
  });

  test("capability tiers resolve to a native alias before matching offered models", async () => {
    const dir = await tempDir("acp-tier-");
    const configMarker = path.join(dir, "config");
    await runFake({
      extraArgs: ["--mode=normal", `--config-marker=${configMarker}`],
      model: "smart",
      // Stands in for `resolveClaudeModel`: tier → CLI alias.
      resolveModel: (m) => (m === "smart" ? "opus" : m),
    });
    await expect(fs.readFile(configMarker, "utf8")).resolves.toBe(
      "model=fake-opus-9-1"
    );
  });

  test("a harness with no model option gets a notice, not a silent drop", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--no-model-option"],
      model: "fake-opus-9-1",
    });
    expect(notices(events)).toContain("model_unsupported");
  });

  test("a model the harness does not offer gets its own notice", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal"],
      model: "some-model-nobody-offers",
    });
    expect(notices(events)).toContain("model_not_offered");
  });

  test("usage comes from the prompt result and is stamped with model + harness", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal"],
      model: "fake-opus-9-1",
    });

    // Exactly one usage event per turn — consumers keep last-write-wins.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    const usage = usageOf(events);
    expect(usage).toMatchObject({
      harness: "acp",
      // Stamped model makes the ledger row repriceable.
      model: "fake-opus-9-1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    });
  });

  test("with no model pinned, usage is stamped with the harness’s current model", async () => {
    const { events } = await runFake({ extraArgs: ["--mode=normal"] });
    expect(usageOf(events)?.model).toBe("fake-model-default");
  });

  test("usage_update cost in USD becomes costUsd", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--cost=0.42"],
    });
    expect(usageOf(events)?.costUsd).toBe(0.42);
  });

  test("a non-USD cost is dropped rather than mislabelled as USD", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--cost=0.42", "--currency=EUR"],
    });
    const usage = usageOf(events);
    // Tokens still land; only the mismatched cost is withheld.
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.costUsd).toBeUndefined();
  });

  test("a refused model request never stamps the unconfirmed requested model", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--no-model-option"],
      model: "unconfirmed-model",
    });
    expect(usageOf(events)?.model).toBeUndefined();
  });

  test("a mid-turn model switch is what the usage event is stamped with", async () => {
    // Mid-turn switch: booking under the pin would reprice at the wrong rate.
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--midturn-model=fake-opus-9-1"],
    });
    expect(usageOf(events)?.model).toBe("fake-opus-9-1");
  });

  test("an option withdrawn by a config_option_update stops being tracked", async () => {
    // Baseline: the harness's effort reaches the stamp…
    const before = await runFake({ extraArgs: ["--mode=normal"] });
    expect(usageOf(before.events)?.effort).toBe("default");

    // …a withdrawn thought_level option must not survive as pin target or stamp.
    const after = await runFake({
      extraArgs: ["--mode=normal", "--midturn-drop-effort"],
    });
    expect(usageOf(after.events)?.effort).toBeUndefined();
    expect(usageOf(after.events)?.inputTokens).toBe(100);
  });

  test("resumed cumulative token and USD totals are booked as deltas", async () => {
    const resumed = await runFake({
      extraArgs: ["--mode=resume-cap", "--cost=0.42"],
      prevSessionId: "existing-session",
      prevUsageSnapshot: {
        inputTokens: 40,
        outputTokens: 20,
        cacheReadTokens: 8,
        cacheWriteTokens: 2,
        cost: { amount: 0.12, currency: "USD" },
      },
    });
    expect(usageOf(resumed.events)).toMatchObject({
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
      costUsd: 0.3,
    });
    expect(resumed.result.usageSnapshot).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  test("a cancelled turn still books the tokens it burned", async () => {
    const { events, result } = await runFake({
      extraArgs: ["--mode=cancel"],
      abortOn: (e) => e.type === "assistant.delta",
    });

    // The abort really happened…
    expect(events.map((e) => e.type)).toContain("aborted");
    // …and the spend is still on the ledger — suppressing it would charge
    // these tokens to nobody.
    expect(usageOf(events)).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(result.usageSnapshot).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  test("an aborted resumed turn advances the snapshot past its own baseline", async () => {
    const { events, result } = await runFake({
      extraArgs: ["--mode=cancel", "--session-resume"],
      prevSessionId: "prev-1",
      prevUsageSnapshot: { inputTokens: 40, outputTokens: 20 },
      abortOn: (e) => e.type === "assistant.delta",
    });

    // Booked delta is cumulative-minus-baseline…
    expect(usageOf(events)).toMatchObject({
      inputTokens: 60,
      outputTokens: 30,
    });
    // …and the persisted baseline moves to the same cumulative total.
    expect(result.usageSnapshot).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
});
