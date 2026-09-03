import { describe, expect, it } from "vitest";

import {
  buildUsageEvent,
  deltaCumulativeUsage,
  readCost,
  readTokenUsage,
} from "./usage.js";

describe(deltaCumulativeUsage, () => {
  it("books the full total when there is no prior snapshot", () => {
    const d = deltaCumulativeUsage(
      { inputTokens: 100, outputTokens: 50 },
      undefined,
      undefined
    );
    expect(d.tokens).toStrictEqual({ inputTokens: 100, outputTokens: 50 });
    expect(d.snapshot).toStrictEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("books cumulative-minus-baseline on a resumed session", () => {
    const d = deltaCumulativeUsage(
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      },
      undefined,
      {
        inputTokens: 40,
        outputTokens: 20,
        cacheReadTokens: 8,
        cacheWriteTokens: 2,
      }
    );
    expect(d.tokens).toStrictEqual({
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
    });
  });

  it("treats a counter regression as a reset and charges the current value in full", () => {
    const d = deltaCumulativeUsage({ inputTokens: 10 }, undefined, {
      inputTokens: 400,
    });
    expect(d.tokens.inputTokens).toBe(10);
    expect(d.snapshot?.inputTokens).toBe(10);
  });

  it("carries prior baseline fields the harness stopped reporting", () => {
    const d = deltaCumulativeUsage({ outputTokens: 90 }, undefined, {
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(d.tokens).toStrictEqual({ outputTokens: 70 });
    expect(d.snapshot).toStrictEqual({ inputTokens: 40, outputTokens: 90 });
  });

  it("ignores non-finite and negative counters rather than booking garbage", () => {
    const d = deltaCumulativeUsage(
      { inputTokens: Number.NaN, outputTokens: -5, cacheReadTokens: 7 },
      undefined,
      undefined
    );
    expect(d.tokens).toStrictEqual({ cacheReadTokens: 7 });
  });

  it("subtracts a same-currency cost baseline, case-insensitively", () => {
    const d = deltaCumulativeUsage(
      {},
      { amount: 0.42, currency: "usd" },
      {
        cost: { amount: 0.12, currency: "USD" },
      }
    );
    expect(d.cost).toStrictEqual({ amount: 0.3, currency: "usd" });
    expect(d.snapshot?.cost).toStrictEqual({ amount: 0.42, currency: "usd" });
  });

  it("charges a changed currency in full instead of subtracting across units", () => {
    const d = deltaCumulativeUsage(
      {},
      { amount: 0.42, currency: "EUR" },
      {
        cost: { amount: 0.12, currency: "USD" },
      }
    );
    expect(d.cost).toStrictEqual({ amount: 0.42, currency: "EUR" });
  });

  it("charges a regressed cost counter in full", () => {
    const d = deltaCumulativeUsage(
      {},
      { amount: 0.05, currency: "USD" },
      {
        cost: { amount: 0.5, currency: "USD" },
      }
    );
    expect(d.cost?.amount).toBe(0.05);
  });

  it("preserves the prior snapshot when the harness reports nothing at all", () => {
    const d = deltaCumulativeUsage({}, undefined, {
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(d.tokens).toStrictEqual({});
    expect(d.snapshot).toStrictEqual({ inputTokens: 40, outputTokens: 20 });
  });

  it("reports no snapshot when there is nothing to remember", () => {
    expect(
      deltaCumulativeUsage({}, undefined, undefined).snapshot
    ).toBeUndefined();
  });
});

describe("readTokenUsage / readCost", () => {
  it("projects the SDK Usage fields into ledger token names", () => {
    expect(
      readTokenUsage({
        totalTokens: 10,
        inputTokens: 1,
        outputTokens: 2,
        cachedReadTokens: 3,
        cachedWriteTokens: 4,
      })
    ).toStrictEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
  });

  it("omits nullable SDK cache counters", () => {
    expect(
      readTokenUsage({
        totalTokens: 3,
        inputTokens: 1,
        outputTokens: 2,
        cachedReadTokens: null,
        cachedWriteTokens: null,
      })
    ).toStrictEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it("projects SDK cost and preserves an absent value", () => {
    expect(readCost(null)).toBeUndefined();
    expect(readCost({ amount: 1.5, currency: "USD" })).toStrictEqual({
      amount: 1.5,
      currency: "USD",
    });
  });
});

describe(buildUsageEvent, () => {
  it("emits nothing when the harness reported nothing worth recording", () => {
    expect(
      buildUsageEvent("acp", "m", undefined, {}, undefined)
    ).toBeUndefined();
  });

  it("withholds a non-USD amount rather than mislabelling it as costUsd", () => {
    const event = buildUsageEvent(
      "acp",
      "m",
      "high",
      { inputTokens: 5 },
      { amount: 3, currency: "EUR" }
    );
    expect(event).toMatchObject({
      type: "usage",
      harness: "acp",
      model: "m",
      inputTokens: 5,
    });
    expect(event).toMatchObject({ effort: "high" });
    expect(event && "costUsd" in event).toBe(false);
  });

  it("does not book a usage row for effort alone", () => {
    expect(buildUsageEvent("acp", "m", "high", {}, undefined)).toBeUndefined();
    expect(
      buildUsageEvent("acp", "m", "high", { inputTokens: 1 }, undefined)
    ).toMatchObject({
      effort: "high",
    });
  });

  it("omits an unconfirmed model so repricing never trusts a guess", () => {
    const event = buildUsageEvent(
      "acp",
      undefined,
      undefined,
      { inputTokens: 5 },
      undefined
    );
    expect(event && "model" in event).toBe(false);
  });
});
