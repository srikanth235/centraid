import { describe, expect, it } from "vitest";

import {
  priceForModel,
  costForUsage,
  resolveItemCost,
  setPricingCatalog,
  filterLiteLLM,
} from "./model-pricing.js";

// costForUsage prices PER TOKEN, so a call of 1,000,000 tokens costs exactly the
// per-MTok anchor. Expected USD are hand-computed from the Anthropic anchors in
// the #445 brief (input / 5m-write / 1h-write / read / output, per MTok).
describe("resolveItemCost (#514)", () => {
  it("F2 runtime pricing gate rejects an unpriced model automatically in test mode", () => {
    expect(() =>
      resolveItemCost({
        model: "provider/new-unpriced-model",
        usage: { inputTokens: 1, outputTokens: 1 },
      })
    ).toThrow("has no pricing catalog entry");
  });
  it("prefers harness-reported USD over catalog", () => {
    const r = resolveItemCost({
      harnessCostUsd: 0.42,
      model: "claude-haiku-4-5",
      usage: { inputTokens: 1_000_000 },
    });
    expect(r.costUsd).toBe(0.42);
    expect(r.costSource).toBe("harness");
  });

  it("falls back to catalog estimate when agent cost is absent", () => {
    const r = resolveItemCost({
      model: "claude-haiku-4-5",
      usage: { inputTokens: 1_000_000 },
    });
    expect(r.costUsd).toBeCloseTo(1, 9);
    expect(r.costSource).toBe("estimated");
  });

  it("fails loudly when an unknown model reaches test runtime", () => {
    expect(() =>
      resolveItemCost({
        model: "totally-unknown-model-xyz",
        usage: { inputTokens: 100 },
      })
    ).toThrow("has no pricing catalog entry");
  });

  it("does not invent a rate for an unpriceable model", () => {
    // A local / self-hosted model, or one newer than the snapshot. Pricing a
    // 2M-token run at any invented rate — least of all the catalog-wide
    // maximum — would stamp `estimated` on a figure that is indistinguishable
    // from a real catalog estimate and can be orders of magnitude high.
    expect(() =>
      resolveItemCost({
        model: "llama-on-my-laptop",
        usage: { inputTokens: 2_000_000, outputTokens: 500_000 },
      })
    ).toThrow("has no pricing catalog entry");
  });

  it("books a real non-zero cost whenever usage is reported AND priceable", () => {
    // The automation acceptance criterion: a fire on any harness that reports
    // usage for a catalog model shows honest money, never 0 and never NULL.
    const r = resolveItemCost({
      model: "claude-haiku-4-5",
      usage: { inputTokens: 12_000, outputTokens: 3_000 },
    });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.costSource).toBe("estimated");
  });

  it("reports nothing when the model is unknown even with tokens in hand", () => {
    expect(
      resolveItemCost({ usage: { inputTokens: 2, outputTokens: 3 } })
    ).toStrictEqual({});
  });
});

describe("costForUsage — Anthropic price anchors (live LiteLLM catalog)", () => {
  it("fable-5: 10 in / 50 out / 12.50 cache-write / 1 cache-read", () => {
    expect(
      costForUsage("claude-fable-5", { inputTokens: 1_000_000 })
    ).toBeCloseTo(10, 9);
    expect(
      costForUsage("claude-fable-5", { outputTokens: 1_000_000 })
    ).toBeCloseTo(50, 9);
    expect(
      costForUsage("claude-fable-5", { cacheWriteTokens: 1_000_000 })
    ).toBeCloseTo(12.5, 9);
    expect(
      costForUsage("claude-fable-5", { cacheReadTokens: 1_000_000 })
    ).toBeCloseTo(1, 9);
  });

  it("opus 4.8 / 4.5: 5 in / 25 out", () => {
    for (const id of ["claude-opus-4-8", "claude-opus-4-5"]) {
      expect(
        costForUsage(id, { inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ).toBeCloseTo(30, 9);
    }
  });

  it("opus 4.1 legacy split: 15 in / 75 out — a per-generation rate the old prefix table could not express", () => {
    expect(
      costForUsage("claude-opus-4-1", { inputTokens: 1_000_000 })
    ).toBeCloseTo(15, 9);
    expect(
      costForUsage("claude-opus-4-1", { outputTokens: 1_000_000 })
    ).toBeCloseTo(75, 9);
    // Same family, newer generation, different price:
    expect(
      costForUsage("claude-opus-4-5", { inputTokens: 1_000_000 })
    ).toBeCloseTo(5, 9);
  });

  it("sonnet 4.x: 3 in / 15 out", () => {
    expect(
      costForUsage("claude-sonnet-4-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toBeCloseTo(18, 9);
  });

  it("haiku 4.5: 1 in / 5 out", () => {
    expect(
      costForUsage("claude-haiku-4-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toBeCloseTo(6, 9);
  });

  it("a codex id prices from the catalog (1.25 in / 10 out, no cache-write rate published)", () => {
    expect(
      costForUsage("gpt-5-codex", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toBeCloseTo(11.25, 9);
    expect(
      costForUsage("gpt-5-codex", { cacheWriteTokens: 1_000_000 })
    ).toBeCloseTo(0, 9);
  });

  it("sums input + output + cacheRead + cacheWrite in one call", () => {
    // haiku: 100k×1 + 50k×5 + 200k×0.1 + 20k×1.25 per MTok = 0.1+0.25+0.02+0.025
    const cost = costForUsage("claude-haiku-4-5", {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 20_000,
    });
    expect(cost).toBeCloseTo(0.395, 9);
  });

  it("treats missing token fields as zero, but still returns a number for a known model", () => {
    expect(costForUsage("claude-haiku-4-5", {})).toBe(0);
  });
});

describe("model-id matching (ccusage rules)", () => {
  it("exact and provider-prefixed forms resolve identically", () => {
    expect(priceForModel("anthropic/claude-opus-4-8")).toStrictEqual(
      priceForModel("claude-opus-4-8")
    );
  });

  it("is case-insensitive", () => {
    expect(priceForModel("CLAUDE-HAIKU-4-5")).toStrictEqual(
      priceForModel("claude-haiku-4-5")
    );
  });

  it("strips regional Bedrock + anthropic. prefixes and a :version suffix", () => {
    expect(
      priceForModel("us.anthropic.claude-opus-4-5-20251101-v1:0")
    ).toStrictEqual(priceForModel("claude-opus-4-5"));
  });

  it("strips a date suffix", () => {
    expect(priceForModel("claude-opus-4-5-20251101")).toStrictEqual(
      priceForModel("claude-opus-4-5")
    );
  });

  it("unknown model → undefined (never a default price)", () => {
    expect(priceForModel("some-future-model-x")).toBeUndefined();
    expect(
      costForUsage("some-future-model-x", { inputTokens: 5000 })
    ).toBeUndefined();
    expect(priceForModel(undefined)).toBeUndefined();
    expect(priceForModel("")).toBeUndefined();
  });

  it("bundled snapshot covers every anchor family", () => {
    for (const id of [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-1",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "gpt-5-codex",
    ]) {
      expect(costForUsage(id, { inputTokens: 1000 })).toBeDefined();
    }
  });
});

describe(filterLiteLLM, () => {
  it("keeps only claude/gpt price fields and drops other families/modalities", () => {
    const out = filterLiteLLM({
      sample_spec: { notes: "ignore" },
      "claude-x": {
        litellm_provider: "anthropic",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        mode: "chat",
        foo: "bar",
      },
      "gpt-x": {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 1e-6,
      },
      "gpt-image-x": {
        litellm_provider: "openai",
        mode: "image_generation",
        input_cost_per_token: 1e-6,
      },
      "whisper-x": { litellm_provider: "openai", mode: "audio_transcription" },
      "gemini-x": { litellm_provider: "vertex_ai", input_cost_per_token: 1e-6 },
    });
    expect(Object.keys(out).sort()).toStrictEqual(["claude-x", "gpt-x"]);
    expect(out["claude-x"]).toStrictEqual({
      litellm_provider: "anthropic",
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    });
  });
});

// These MUTATE the process-global catalog, so they run LAST (vitest isolates
// modules per file, so this never leaks to other test files).
describe("setPricingCatalog overlay", () => {
  it("overlay replaces the table; longest boundary match beats a shorter prefix", () => {
    setPricingCatalog({
      "claude-3-5": {
        input_cost_per_token: 9e-6,
        output_cost_per_token: 9e-6,
        litellm_provider: "anthropic",
      },
      "claude-3-5-sonnet": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
        litellm_provider: "anthropic",
      },
      "model-x": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    });
    // -sonnet-<date> resolves via the LONGER key, not claude-3-5.
    expect(
      costForUsage("claude-3-5-sonnet-20240620", { inputTokens: 1_000_000 })
    ).toBeCloseTo(3, 9);
    // Boundary safety: claude-3-55 must NOT match claude-3-5.
    expect(
      costForUsage("claude-3-55-foo", { inputTokens: 1_000_000 })
    ).toBeUndefined();
    // The overlay replaces the bundled snapshot outright.
    expect(priceForModel("claude-opus-4-8")).toBeUndefined();
    expect(costForUsage("model-x", { inputTokens: 1_000_000 })).toBeCloseTo(
      1,
      9
    );
    // A model absent from the overlay stays unpriced — the overlay's most
    // expensive entry is never borrowed to stand in for it.
    expect(() =>
      resolveItemCost({
        model: "not-in-this-overlay",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      })
    ).toThrow("has no pricing catalog entry");
  });

  it("an empty overlay never clobbers the current table", () => {
    setPricingCatalog({});
    expect(costForUsage("model-x", { inputTokens: 1_000_000 })).toBeCloseTo(
      1,
      9
    );
  });
});
