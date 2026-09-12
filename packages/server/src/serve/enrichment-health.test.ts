import { describe, expect, it } from "vitest";

import { createEnrichmentHealthProbe } from "./enrichment-health.js";
import type { EnrichmentAutomationRow } from "./enrichment-health.js";

function row(id: string, enabled: boolean): EnrichmentAutomationRow {
  return { id, enabled, ref: `${id}/${id}` };
}

describe(createEnrichmentHealthProbe, () => {
  it("reports ok, zero enabled, when no enricher is installed", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "v1",
          listAutomations: async () => [],
          recentRuns: () => [],
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("0 of 0 enrichers armed");
  });

  it("ignores automations that are not enrichers, and counts disabled ones as installed only", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "v1",
          listAutomations: async () => [
            row("embed-text", false),
            row("some-other-app", true),
          ],
          recentRuns: () => [],
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("0 of 1 enricher armed");
  });

  it("counts a system recipe as armed whatever its stale enabled bit says", async () => {
    // #1014, B21. Install rewrites the catalogue's flag every boot and
    // reconcile arms every system row unconditionally
    // (docs/recognition-automations.md), so skipping `enabled === false` here
    // made health and the scheduler disagree about what is running.
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "v1",
          listAutomations: async () => [
            row("doc-text-extractor", false),
            row("faces", false),
            row("photo-ocr", false),
          ],
          recentRuns: () => [],
        },
      ],
    });
    const result = await probe();
    expect(result.detail).toContain("3 of 3 enrichers armed");
  });

  it("tracks the self-contained recognition recipes as ordinary enrichers", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "v1",
          listAutomations: async () => [
            row("photo-ocr", true),
            row("transcript", false),
            row("embed-image", false),
            row("embed-text", false),
            row("faces", true),
          ],
          recentRuns: () => [],
        },
      ],
    });

    await expect(probe()).resolves.toStrictEqual({
      status: "ok",
      detail: "2 of 5 enrichers armed",
    });
  });

  it("reports ok for an enabled enricher that has never fired yet (honest unknown, not a failure)", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "v1",
          listAutomations: async () => [row("doc-filer", true)],
          recentRuns: () => [],
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("1 of 1 enricher armed");
  });

  it("reports ok for an enabled enricher whose latest run succeeded", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "v1",
          listAutomations: async () => [row("doc-filer", true)],
          recentRuns: () => [{ ok: true, endedAt: 1_000 }],
        },
      ],
      now: () => 2_000,
    });
    expect((await probe()).status).toBe("ok");
  });

  it("degrades on a single recent failure, below the persistent-failure streak", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "vault-aaaaaaaa",
          listAutomations: async () => [row("doc-text-extractor", true)],
          recentRuns: () => [{ ok: false }, { ok: true }, { ok: true }],
        },
      ],
      persistentFailureStreak: 3,
    });
    const result = await probe();
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("recent failure");
    expect(result.detail).toContain("vault-aa/doc-text-extractor");
  });

  it("escalates to error when the last N runs (the streak) all failed", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "vault-aaaaaaaa",
          listAutomations: async () => [row("doc-text-extractor", true)],
          recentRuns: () => [{ ok: false }, { ok: false }, { ok: false }],
        },
      ],
      persistentFailureStreak: 3,
    });
    const result = await probe();
    expect(result.status).toBe("error");
    expect(result.detail).toContain("persistently failing");
    expect(result.detail).toContain("vault-aa/doc-text-extractor");
  });

  it("flags a successful-but-stale enricher as degraded", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "v1",
          listAutomations: async () => [row("obligation-extractor", true)],
          recentRuns: () => [{ ok: true, endedAt: 0 }],
        },
      ],
      staleAfterMs: 60_000,
      now: () => 120_000,
    });
    const result = await probe();
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("stale");
  });

  it("tolerates a vault whose workspace is not mounted yet, skipping it rather than erroring", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "v1",
          listAutomations: async () => {
            throw new Error("gateway: vault v1 workspace not mounted yet");
          },
          recentRuns: () => [],
        },
      ],
    });
    await expect(probe()).resolves.toStrictEqual({
      status: "ok",
      detail: "0 of 0 enrichers armed",
    });
  });

  it("aggregates enabled counts across multiple vaults", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "vault-a",
          listAutomations: async () => [row("doc-filer", true)],
          recentRuns: () => [],
        },
        {
          vaultId: "vault-b",
          listAutomations: async () => [
            row("doc-filer", true),
            row("obligation-extractor", false),
          ],
          recentRuns: () => [],
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("2 of 3 enrichers armed");
  });
});

describe("progress and the poison register (#1014, B2)", () => {
  const runs = [{ ok: true, endedAt: Date.now() }];

  it("calls a frozen walk degraded even though every fire succeeded", async () => {
    // The exact shape one poisoned asset produced: the recipe fires every five
    // minutes, every fire succeeds, and the library has not moved in a month.
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "vault-1234",
          listAutomations: async () => [row("faces", true)],
          recentRuns: () => runs,
          progress: () => ({
            done: 12,
            total: 5000,
            advancedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
          }),
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("no progress");
    expect(result.detail).toContain("12/5000");
  });

  it("stays ok once the walk has finished the library", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "vault-1234",
          listAutomations: async () => [row("faces", true)],
          recentRuns: () => runs,
          progress: () => ({
            done: 5000,
            total: 5000,
            advancedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
          }),
        },
      ],
    });
    expect((await probe()).status).toBe("ok");
  });

  it("lists declined targets, so a recorded poison is visible rather than silent", async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "vault-1234",
          listAutomations: async () => [row("faces", true)],
          recentRuns: () => runs,
          targetFailures: () => [
            { capability: "faces", declined: 3, failing: 1 },
          ],
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("3 declined, 1 retrying");
  });
});
