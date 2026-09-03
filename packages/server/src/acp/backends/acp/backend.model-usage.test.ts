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
    expect(notices(events)).not.toContain("model_unsupported");
    expect(notices(events)).not.toContain("model_not_offered");
  });

  test("capability tiers resolve to a native alias before matching offered models", async () => {
    const dir = await tempDir("acp-tier-");
    const configMarker = path.join(dir, "config");
    await runFake({
      extraArgs: ["--mode=normal", `--config-marker=${configMarker}`],
      model: "smart",
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

    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    const usage = usageOf(events);
    expect(usage).toMatchObject({
      harness: "acp",
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
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--midturn-model=fake-opus-9-1"],
    });
    expect(usageOf(events)?.model).toBe("fake-opus-9-1");
  });

  test("an option withdrawn by a config_option_update stops being tracked", async () => {
    const before = await runFake({ extraArgs: ["--mode=normal"] });
    expect(usageOf(before.events)?.effort).toBe("default");

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

    expect(events.map((e) => e.type)).toContain("aborted");
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

    expect(usageOf(events)).toMatchObject({
      inputTokens: 60,
      outputTokens: 30,
    });
    expect(result.usageSnapshot).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
});
