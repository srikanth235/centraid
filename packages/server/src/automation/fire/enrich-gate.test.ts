// governance: allow-repo-hygiene file-size-limit (#807) one gate suite — tier ranks, the scoped cascade, profile egress and the consent step are one decision and share the real fire spine, policy seam and dispatch fixtures
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { ledgerDbFileIn } from "../../engine/stores/ledger-db.test-fixtures.js";
import { readEngineProfile } from "../../enrich/engine-profiles.js";
import type { Manifest } from "../manifest/manifest.js";
import {
  decideEnrichmentGate,
  resolveEnrichmentPolicy,
} from "./enrich-gate.js";
import type {
  EnrichConsentRecord,
  EnrichLane,
  EnrichTier,
  ResolveEnrichPolicy,
} from "./enrich-gate.js";
import { runFire } from "./fire.js";
import type { DispatchSurface, OpenDispatchArgs } from "./fire.js";

function enricherManifest(lane: EnrichLane): Manifest {
  return {
    name: "Face proposals",
    version: "0.1.0",
    enabled: true,
    prompt: "find faces",
    triggers: [{ kind: "cron", expr: "*/10 * * * *" }],
    requires: {},
    enrich: { domain: "photos", capability: "faces", lane },
    history: { keep: { count: 100 } },
    generated: { by: "test", at: "2026-08-05" },
  };
}

async function writeAutomation(
  appsDir: string,
  m: Manifest,
  handler = "export default async () => ({ ok: true });"
): Promise<void> {
  const dir = path.join(appsDir, "photos", "automations", "face-finder");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "automation.json"),
    JSON.stringify(m, null, 2)
  );
  await fs.writeFile(path.join(dir, "handler.js"), handler);
}

describe("enrichment tier gate", () => {
  let appsDir: string;
  let ledgerDbFile: string;

  beforeEach(async () => {
    appsDir = await tempDir("centraid-enrich-gate-");
    ledgerDbFile = ledgerDbFileIn(appsDir);
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  function countingDispatch(opened: OpenDispatchArgs[]) {
    return (args: OpenDispatchArgs): Promise<DispatchSurface> => {
      opened.push(args);
      return Promise.resolve({
        delegateDispatcher: () => Promise.resolve("a model answer"),
        close: () => Promise.resolve(),
      });
    };
  }

  async function fire(options: {
    lane: EnrichLane;
    resolveEnrichPolicy?: ResolveEnrichPolicy;
    handler?: string;
  }) {
    await writeAutomation(
      appsDir,
      enricherManifest(options.lane),
      options.handler
    );
    const opened: OpenDispatchArgs[] = [];
    const result = await runFire(
      {
        automationRef: "photos/face-finder",
        appsDir,
        ledgerDbFile,
        ...(options.resolveEnrichPolicy
          ? { resolveEnrichPolicy: options.resolveEnrichPolicy }
          : {}),
      },
      { openDispatch: countingDispatch(opened) }
    );
    return { ...result, opened };
  }

  it("refuses the fire when the owner switched enrichment off, naming the reason", async () => {
    const { outcome, record, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: () => "off",
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("enrichment is switched off");
    expect(outcome.error).toContain("photos");
    expect(record.error).toStrictEqual(outcome.error);
    expect(opened).toStrictEqual([]);
  });

  it("refuses a gateway-lane enricher when the tier is device, because every harness is remote", async () => {
    const { outcome, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: () => "device",
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain('set to "device"');
    expect(outcome.error).toContain("leave this member's trust domain");
    expect(opened).toStrictEqual([]);
  });

  it("fails closed when the host wired no policy seam at all", async () => {
    const { outcome, opened } = await fire({ lane: "gateway" });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("could not be read");
    expect(opened).toStrictEqual([]);
  });

  it("fails closed when reading the policy throws", async () => {
    const { outcome, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: () => Promise.reject(new Error("vault is locked")),
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("could not be read");
    expect(opened).toStrictEqual([]);
  });

  it("lets a gateway-lane enricher run when the owner set the tier to gateway", async () => {
    const { outcome, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: () => "gateway",
      handler: `export default async ({ ctx }) => ({ output: await ctx.delegate({ prompt: 'find faces' }) });`,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.skipped).toBeUndefined();
    expect(opened).toHaveLength(1);
  });

  it("runs a device-lane enricher under device but seals ctx.delegate shut", async () => {
    const { outcome } = await fire({
      lane: "device",
      resolveEnrichPolicy: () => "device",
      handler: `export default async ({ ctx }) => ({ output: await ctx.delegate({ prompt: 'sneak a model turn' }) });`,
    });

    expect(outcome.skipped).toBeUndefined();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("ctx.delegate is refused");
  });

  it("refuses an explicit delegate step until the owner pins a model", async () => {
    await writeAutomation(appsDir, {
      ...enricherManifest("device"),
      enrich: {
        domain: "photos",
        capability: "ocr",
        lane: "device",
        delegateStep: {
          selected: "delegate",
          promptRev: "ocr-v1",
          latency: "seconds instead of milliseconds",
          consequence: "billed and re-derives eligible photographs",
        },
      },
    });
    const opened: OpenDispatchArgs[] = [];

    const { outcome } = await runFire(
      {
        automationRef: "photos/face-finder",
        appsDir,
        ledgerDbFile,
        resolveEnrichPolicy: () => "gateway",
      },
      { openDispatch: countingDispatch(opened) }
    );

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("requires an explicit pinned model");
    expect(outcome.error).toContain("provider-egress consent");
    expect(opened).toStrictEqual([]);
  });

  it("leaves a non-enricher automation entirely alone", async () => {
    await writeAutomation(appsDir, {
      name: "Digest",
      version: "0.1.0",
      enabled: true,
      prompt: "do the thing",
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      requires: {},
      history: { keep: { count: 100 } },
      generated: { by: "test", at: "2026-08-05" },
    });
    const opened: OpenDispatchArgs[] = [];

    const { outcome } = await runFire(
      { automationRef: "photos/face-finder", appsDir, ledgerDbFile },
      { openDispatch: countingDispatch(opened) }
    );

    expect(outcome.ok).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it.each(["off", "device"] as const)(
    "recognition gateway recipes do not start their handler at the %s tier",
    async (tier) => {
      const { outcome, opened } = await fire({
        lane: "gateway",
        resolveEnrichPolicy: () => tier,
        handler: `export default async () => ({ output: { ran: true } });`,
      });
      expect(outcome.skipped).toBe(true);
      expect(opened).toStrictEqual([]);
    }
  );

  it("refuses when a rule switches the capability off, even at the gateway tier", async () => {
    const { outcome, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: (request) => ({
        tier: "gateway",
        rules: [
          {
            scope: { type: "domain", ref: request.domain },
            capability: request.capability,
            enabled: false,
            profile: null,
            trigger: null,
            updatedAt: "2026-08-16T00:00:00.000Z",
          },
        ],
        egressForProfile: () => "gateway",
      }),
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("switched off");
    expect(outcome.error).toContain("faces");
    expect(opened).toStrictEqual([]);
  });

  it("refuses a profile whose egress reaches further than the vault's ceiling", async () => {
    const { outcome, opened } = await fire({
      lane: "device",
      resolveEnrichPolicy: (request) => ({
        tier: "device",
        rules: [
          {
            scope: { type: "domain", ref: request.domain },
            capability: request.capability,
            enabled: true,
            profile: "provider-vlm",
            trigger: null,
            updatedAt: "2026-08-16T00:00:00.000Z",
          },
        ],
        egressForProfile: () => "provider",
      }),
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("provider-vlm");
    expect(outcome.error).toContain("no further than");
    expect(opened).toStrictEqual([]);
  });

  function providerCascade(consent?: EnrichConsentRecord | null) {
    return ((request) => ({
      tier: "gateway" as const,
      rules: [
        {
          scope: { type: "domain" as const, ref: request.domain },
          capability: request.capability,
          enabled: true,
          profile: "provider-vlm",
          trigger: null,
          updatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      egressForProfile: () => "provider" as const,
      egressConsent: () => consent ?? null,
    })) satisfies ResolveEnrichPolicy;
  }

  it("refuses a provider engine when this vault holds no egress answer", async () => {
    const { outcome, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: providerCascade(null),
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("faces");
    expect(outcome.error).toContain("no egress consent");
    expect(outcome.error).toContain("an absent answer is not a grant");
    expect(opened).toStrictEqual([]);
  });

  it("refuses a provider engine the member declined, naming when they said so", async () => {
    const { outcome, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: providerCascade({
        capability: "faces",
        egress: "provider",
        scopeRef: "",
        decision: "declined",
        decidedAt: "2026-08-14T09:00:00.000Z",
        receiptId: null,
      }),
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("was declined on 2026-08-14T09:00:00.000Z");
    expect(opened).toStrictEqual([]);
  });

  it("runs a provider engine once the member granted that egress", async () => {
    const { outcome, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: providerCascade({
        capability: "faces",
        egress: "provider",
        scopeRef: "",
        decision: "granted",
        decidedAt: "2026-08-14T09:00:00.000Z",
        receiptId: "receipt-1",
      }),
      handler: `export default async ({ ctx }) => ({ output: await ctx.delegate({ prompt: 'find faces' }) });`,
    });

    expect(outcome.ok).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it.each(["device", "gateway"] as const)(
    "runs a tier-only vault's own engine under %s with an empty consent ledger",
    async (tier) => {
      const asked: string[] = [];
      const { outcome, opened } = await fire({
        lane: tier === "device" ? "device" : "gateway",
        resolveEnrichPolicy: () => ({
          tier,
          rules: [],
          egressForProfile: () => (tier === "device" ? "on-device" : "gateway"),
          egressConsent: (egress) => {
            asked.push(egress);
            return null; // an empty ledger, as a legacy vault has
          },
        }),
      });

      expect(outcome.ok).toBe(true);
      expect(opened).toHaveLength(1);
      expect(asked).toStrictEqual([]);
    }
  );

  it("does not let a device-scoped on-device decline refuse the gateway's own work", async () => {
    const { outcome, opened } = await fire({
      lane: "device",
      resolveEnrichPolicy: () => ({
        tier: "device",
        rules: [],
        egressForProfile: () => "on-device",
        egressConsent: (egress) => ({
          capability: "faces",
          egress,
          scopeRef: "",
          decision: "declined",
          decidedAt: "2026-08-14T09:00:00.000Z",
          receiptId: null,
        }),
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it("asks the host for the firing capability's own scope chain", async () => {
    const asked: unknown[] = [];
    await fire({
      lane: "gateway",
      resolveEnrichPolicy: (request) => {
        asked.push(request);
        return {
          tier: "gateway",
          rules: [],
          egressForProfile: () => "gateway",
        };
      },
    });

    expect(asked).toStrictEqual([
      {
        domain: "photos",
        capability: "faces",
        lane: "gateway",
        scopeChain: [
          { type: "vault", ref: "" },
          { type: "domain", ref: "photos" },
        ],
      },
    ]);
  });

  it("runs the built-in engine under the cascade exactly as the bare tier did", async () => {
    const { outcome, opened } = await fire({
      lane: "gateway",
      resolveEnrichPolicy: () => ({
        tier: "gateway",
        rules: [],
        egressForProfile: () => "gateway",
      }),
      handler: `export default async ({ ctx }) => ({ output: await ctx.delegate({ prompt: 'find faces' }) });`,
    });

    expect(outcome.ok).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it("keeps ctx.fetch connector-only for a non-enricher", async () => {
    await writeAutomation(
      appsDir,
      {
        name: "Digest",
        version: "0.1.0",
        enabled: true,
        prompt: "do the thing",
        triggers: [{ kind: "cron", expr: "0 9 * * *" }],
        requires: {},
        history: { keep: { count: 100 } },
        generated: { by: "test", at: "2026-08-05" },
      },
      `export default async ({ ctx }) => ({ output: await ctx.fetch({ url: 'https://example.test', method: 'GET' }) });`
    );
    const { outcome } = await runFire(
      {
        automationRef: "photos/face-finder",
        appsDir,
        ledgerDbFile,
      },
      { openDispatch: countingDispatch([]) }
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("ctx.fetch is connector-only");
  });
});

describe(decideEnrichmentGate, () => {
  const base = {
    automationRef: "photos/face-finder",
    domain: "photos",
    capability: "faces",
  } as const;

  it("names the automation and the capability in every refusal", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "gateway",
      tier: "off",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "photos/face-finder"
    );
    expect(decision.allowed === false && decision.reason).toContain("faces");
  });

  it("allows the gateway tier without sealing model turns", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "gateway",
      tier: "gateway",
    });

    expect(decision).toStrictEqual({ allowed: true, sealModelTurns: false });
  });

  it("allows the device lane under device, with model turns sealed", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "device",
      tier: "device",
    });

    expect(decision).toStrictEqual({ allowed: true, sealModelTurns: true });
  });

  it("[C5] the gate is rank(lane) <= rank(tier) — device lane is allowed even under the off tier's neighbour, gateway", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "device",
      tier: "gateway",
    });

    expect(decision).toStrictEqual({ allowed: true, sealModelTurns: false });
  });

  const resolved = (tier: EnrichTier, profileId = "built-in") =>
    resolveEnrichmentPolicy(
      [
        {
          scope: { type: "vault", ref: "" },
          capability: "faces",
          enabled: null,
          profile: profileId,
          trigger: null,
          updatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      tier,
      "faces"
    );

  it("names the egress class Wave 3 must confirm consent for", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "gateway",
      tier: "gateway",
      policy: resolved("gateway")!,
      profileEgress: "gateway",
    });

    expect(decision).toStrictEqual({
      allowed: true,
      sealModelTurns: false,
      egressConsentNeeded: "gateway",
    });
  });

  it("refuses a profile that goes further than the vault's ceiling", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "device",
      tier: "device",
      policy: resolved("device", "provider-vlm")!,
      profileEgress: "provider",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "provider-vlm"
    );
  });

  it("refuses a profile this gateway does not carry, rather than falling back", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "device",
      tier: "gateway",
      policy: resolved("gateway", "ghost")!,
      profileEgress: undefined,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "does not carry"
    );
  });

  it("refuses an enricher whose capability this gateway carries no contract for", () => {
    const policy = resolveEnrichmentPolicy([], "gateway", "sentiment")!;
    const decision = decideEnrichmentGate({
      automationRef: "photos/mood-reader",
      domain: "photos",
      capability: "sentiment",
      lane: "gateway",
      tier: "gateway",
      policy,
      profileEgress: readEngineProfile({}, policy.profileId, "sentiment")
        ?.egress,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "does not carry"
    );
    expect(decision.allowed === false && decision.reason).toContain(
      "sentiment"
    );
  });

  it("keeps the device ceiling sealing model turns under the cascade", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "device",
      tier: "device",
      policy: resolved("device")!,
      profileEgress: "on-device",
    });

    expect(decision).toStrictEqual({
      allowed: true,
      sealModelTurns: true,
      egressConsentNeeded: "on-device",
    });
  });
});
