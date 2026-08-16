/*
 * The enrichment tier gate — the privacy promise as behaviour.
 *
 * `enrich_policy` says what a vault allows per domain (`off | device |
 * gateway`); Photos tells the member "what leaves the device: nothing" when
 * the tier is `device`. These tests pin that the FIRE PATH keeps that
 * promise: an enricher fire is refused with a stated reason under `off`,
 * refused under `device` when it needs the `gateway` lane (a model turn),
 * and — critically — refused when the policy cannot be read at all, because
 * an unreadable policy is not consent.
 *
 * The gate is exercised through `runFire` with a stub dispatch surface, so a
 * refusal is observable exactly as the ledger sees it: `outcome.skipped` with
 * the reason, and no dispatch surface ever opened.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { Manifest } from "../manifest/manifest.js";
import {
  decideEnrichmentGate,
  resolveEnrichmentPolicy,
} from "./enrich-gate.js";
import type {
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
  let journalDbFile: string;

  beforeEach(async () => {
    appsDir = await tempDir("centraid-enrich-gate-");
    journalDbFile = path.join(appsDir, "journal.db");
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  /** Records whether the host was ever asked for a dispatch surface. */
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
        journalDbFile,
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
    // The reason reaches the run record the ledger/notice is built from.
    expect(record.error).toStrictEqual(outcome.error);
    // Nothing was started: no dispatch surface, no harness process.
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

    // The fire was allowed to start (deterministic work is device-tier
    // work), and the model turn inside it failed loudly rather than
    // reaching a provider.
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
        journalDbFile,
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
      { automationRef: "photos/face-finder", appsDir, journalDbFile },
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

  // ── the cascade on the fire path (issue #807, Wave 2) ────────────────────
  // The seam grew from "a tier" to "the tier plus this capability's rule chain
  // plus a profile→egress lookup". A host that still answers with a bare tier
  // gets the pre-#807 decision (every test above); a host that answers with
  // the cascade gets the same gate, one resolver deeper.

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
      lane: "gateway",
      resolveEnrichPolicy: (request) => ({
        tier: "gateway",
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
        // A delegate profile: every harness in this runtime reaches a provider.
        egressForProfile: () => "provider",
      }),
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("provider-vlm");
    expect(outcome.error).toContain("no further than");
    expect(opened).toStrictEqual([]);
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
        journalDbFile,
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
    // A device-lane enricher never needs more than `device`, so it is also
    // allowed under the wider `gateway` tier — the rank comparison, not a
    // per-tier branch, is what decides this.
    const decision = decideEnrichmentGate({
      ...base,
      lane: "device",
      tier: "gateway",
    });

    expect(decision).toStrictEqual({ allowed: true, sealModelTurns: false });
  });

  // ── the profile-aware form (issue #807) ─────────────────────────────────
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
