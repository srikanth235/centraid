// Model pinning through `session/set_config_option`, and the single
// end-of-turn `usage` event it stamps. Core turn behaviour is in
// backend.test.ts; shared fixtures in test-fixtures.ts.

import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { notices, runFake, usageOf } from "./test-fixtures.js";

describe("backend.model-usage suite", () => {
  // ---- model pinning via session config options ----------------------------

  test("a pinned model is selected through session/set_config_option", async () => {
    const dir = await tempDir("acp-model-");
    const configMarker = path.join(dir, "config");
    const { events } = await runFake({
      extraArgs: ["--mode=normal", `--config-marker=${configMarker}`],
      model: "fake-opus-9-1",
    });

    // The agent saw the pin on its own `model` config option.
    await expect(fs.readFile(configMarker, "utf8")).resolves.toBe(
      "model=fake-opus-9-1"
    );
    // A successful pin is silent — no "harness picks its own model" notice.
    expect(notices(events)).not.toContain("model_unsupported");
    expect(notices(events)).not.toContain("model_not_offered");
  });

  test("capability tiers resolve to a native alias before matching offered models", async () => {
    const dir = await tempDir("acp-tier-");
    const configMarker = path.join(dir, "config");
    await runFake({
      extraArgs: ["--mode=normal", `--config-marker=${configMarker}`],
      model: "smart",
      // Stands in for `resolveClaudeModel`: tier → CLI alias, which then
      // substring-matches the concrete id the agent advertises.
      resolveModel: (m) => (m === "smart" ? "opus" : m),
    });
    await expect(fs.readFile(configMarker, "utf8")).resolves.toBe(
      "model=fake-opus-9-1"
    );
  });

  test("an agent with no model option gets a notice, not a silent drop", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--no-model-option"],
      model: "fake-opus-9-1",
    });
    expect(notices(events)).toContain("model_unsupported");
  });

  test("a model the agent does not offer gets its own notice", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal"],
      model: "some-model-nobody-offers",
    });
    expect(notices(events)).toContain("model_not_offered");
  });

  // ---- usage ---------------------------------------------------------------

  test("usage comes from the prompt result and is stamped with model + provider", async () => {
    const { events } = await runFake({
      extraArgs: ["--mode=normal"],
      model: "fake-opus-9-1",
    });

    // Exactly one usage event per turn — consumers keep last-write-wins.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    const usage = usageOf(events);
    expect(usage).toMatchObject({
      provider: "acp",
      // Stamping the model is what makes the ledger row repriceable.
      model: "fake-opus-9-1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    });
  });

  test("with no model pinned, usage is stamped with the agent’s current model", async () => {
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
    // Tokens still land; only the currency-mismatched cost is withheld.
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

  // ---- mid-turn config_option_update ---------------------------------------

  test("a mid-turn model switch is what the usage event is stamped with", async () => {
    // The agent switched models after the pin, and said so on the wire. Booking
    // the tokens under the model pinned at the start of the turn would reprice
    // the whole turn at the wrong rate.
    const { events } = await runFake({
      extraArgs: ["--mode=normal", "--midturn-model=fake-opus-9-1"],
    });
    expect(usageOf(events)?.model).toBe("fake-opus-9-1");
  });

  test("an option withdrawn by a config_option_update stops being tracked", async () => {
    // Baseline: the agent's advertised effort reaches the usage stamp…
    const before = await runFake({ extraArgs: ["--mode=normal"] });
    expect(usageOf(before.events)?.effort).toBe("default");

    // …and once the agent's full-set update no longer carries a thought_level
    // option, the stale value must not survive as a pin target or a stamp.
    const after = await runFake({
      extraArgs: ["--mode=normal", "--midturn-drop-effort"],
    });
    expect(usageOf(after.events)?.effort).toBeUndefined();
    // Tokens are unaffected — only the withdrawn configuration is dropped.
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
    // …and the spend is still on the ledger. Suppressing this event while the
    // snapshot advanced would charge these tokens to nobody, and the next turn
    // would subtract a baseline it was never billed for.
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
    // …and the persisted baseline moves to the same cumulative total, so the
    // two can never disagree about what has already been charged.
    expect(result.usageSnapshot).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
});
