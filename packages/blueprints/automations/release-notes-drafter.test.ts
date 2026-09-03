import { describe, expect, it } from "vitest";

import { createHarness, loadEnricher } from "./handler-harness.js";

describe("release-notes-drafter", () => {
  it.each([
    [
      "a PR opened event",
      { action: "opened", pull_request: { merged: false } },
    ],
    [
      "a close without a merge",
      { action: "closed", pull_request: { merged: false } },
    ],
    ["a payload with no pull_request", { action: "closed" }],
    ["a non-object payload", "zen"],
  ])("skips %s before anything is billed", async (_name, payload) => {
    const handler = await loadEnricher("release-notes-drafter");
    const harness = createHarness({ input: payload });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
    };

    expect(result.summary).toBe("skipped: not a merge event");
    expect(harness.delegateCalls).toHaveLength(0);
    expect(harness.invokes).toHaveLength(0);
  });

  it("drafts from a bounded prompt on a merge and returns the draft as output", async () => {
    const handler = await loadEnricher("release-notes-drafter");
    const harness = createHarness({
      input: {
        action: "closed",
        repository: { full_name: "acme/widgets" },
        pull_request: {
          merged: true,
          number: 41,
          title: `T${"t".repeat(400)}`,
          body: `B${"b".repeat(5000)}`,
        },
      },
      delegate: (call) => {
        expect(call.prompt).toContain("acme/widgets #41");
        expect(call.prompt).toContain(`Title: T${"t".repeat(299)}\n`);
        expect(call.prompt).not.toContain("t".repeat(300));
        expect(call.prompt).not.toContain("b".repeat(4000));
        return { headline: "  Faster widget search  ", body: "Details." };
      },
    });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
      output: { headline: string; body: string };
    };

    expect(result.summary).toBe("Faster widget search");
    expect(result.output).toStrictEqual({
      headline: "  Faster widget search  ",
      body: "Details.",
    });
    expect(harness.invokes).toHaveLength(0);
  });

  it("falls back to a stock summary when the draft has no usable headline", async () => {
    const handler = await loadEnricher("release-notes-drafter");
    const harness = createHarness({
      input: {
        action: "closed",
        pull_request: { merged: true, number: 2, title: "x", body: "" },
      },
      delegate: () => ({ headline: "   ", body: "only body" }),
    });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
    };

    expect(result.summary).toBe("release note drafted");
  });
});
