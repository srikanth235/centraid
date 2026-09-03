import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { ledgerDbFileIn } from "../../engine/stores/ledger-db.test-fixtures.js";
import type { Manifest, ManifestEnrich } from "../manifest/manifest.js";
import type {
  ResolveEnrichPolicy,
  ResolvedEngineBinding,
} from "./enrich-gate.js";
import { runFire } from "./fire.js";
import type { DispatchSurface, OpenDispatchArgs } from "./fire.js";

const DELEGATE_STEP: NonNullable<ManifestEnrich["delegateStep"]> = {
  selected: "deterministic",
  promptRev: "ocr-v1",
  latency: "seconds instead of milliseconds",
  consequence: "billed and re-derives eligible photographs",
};

function manifest(options: {
  enrich: ManifestEnrich;
  model?: string;
}): Manifest {
  return {
    name: "Photo OCR",
    version: "0.1.0",
    enabled: true,
    prompt: "extract text",
    triggers: [{ kind: "cron", expr: "*/10 * * * *" }],
    requires: options.model ? { model: options.model } : {},
    enrich: options.enrich,
    history: { keep: { count: 100 } },
    generated: { by: "test", at: "2026-08-17" },
  };
}

function cascade(
  profileId: string,
  engine: ResolvedEngineBinding | undefined
): ResolveEnrichPolicy {
  return (request) => ({
    tier: "gateway",
    rules: [
      {
        scope: { type: "domain", ref: request.domain },
        capability: request.capability,
        enabled: true,
        profile: profileId,
        trigger: null,
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
    ],
    egressForProfile: () =>
      engine?.kind === "delegate" ? "provider" : "gateway",
    egressConsent: () => ({
      capability: request.capability,
      egress: "provider",
      scopeRef: "",
      decision: "granted",
      decidedAt: "2026-08-14T09:00:00.000Z",
      receiptId: "receipt-1",
    }),
    engineForProfile: () => engine,
  });
}

describe("engine-profile selection on the fire path", () => {
  let appsDir: string;
  let ledgerDbFile: string;

  beforeEach(async () => {
    appsDir = await tempDir("centraid-engine-selection-");
    ledgerDbFile = ledgerDbFileIn(appsDir);
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  const ECHO_HANDLER =
    "export default async ({ ctx }) => ({ output: { input: ctx.input ?? null } });";

  async function fire(options: {
    manifest: Manifest;
    resolveEnrichPolicy?: ResolveEnrichPolicy;
    handler?: string;
  }) {
    const dir = path.join(appsDir, "photos", "automations", "ocr");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "automation.json"),
      JSON.stringify(options.manifest, null, 2)
    );
    await fs.writeFile(
      path.join(dir, "handler.js"),
      options.handler ?? ECHO_HANDLER
    );
    const opened: OpenDispatchArgs[] = [];
    const logs: string[] = [];
    const result = await runFire(
      {
        automationRef: "photos/ocr",
        appsDir,
        ledgerDbFile,
        onLog: (_level, message) => logs.push(message),
        ...(options.resolveEnrichPolicy
          ? { resolveEnrichPolicy: options.resolveEnrichPolicy }
          : {}),
      },
      {
        openDispatch: (args: OpenDispatchArgs): Promise<DispatchSurface> => {
          opened.push(args);
          return Promise.resolve({
            delegateDispatcher: () => Promise.resolve("an answer"),
            close: () => Promise.resolve(),
          });
        },
      }
    );
    return { ...result, opened, logs };
  }

  const ocrEnrich: ManifestEnrich = {
    domain: "photos",
    capability: "ocr",
    lane: "gateway",
    delegateStep: DELEGATE_STEP,
  };

  function injectedInput(outcome: { output?: unknown }): unknown {
    return (outcome.output as { input: unknown }).input;
  }

  it("[law 1] fires the deterministic variant for a tier-only vault, exactly as before", async () => {
    const { outcome } = await fire({
      manifest: manifest({ enrich: ocrEnrich }),
      resolveEnrichPolicy: () => "gateway",
    });

    expect(outcome.ok).toBe(true);
    expect(injectedInput(outcome)).toStrictEqual({
      variant: "deterministic",
      profileId: "built-in",
    });
  });

  it("[law 1] fires the deterministic variant when the cascade resolves the built-in profile", async () => {
    const { outcome, opened } = await fire({
      manifest: manifest({ enrich: ocrEnrich }),
      resolveEnrichPolicy: cascade("built-in", { kind: "built-in" }),
    });

    expect(injectedInput(outcome)).toStrictEqual({
      variant: "deterministic",
      profileId: "built-in",
    });
    expect(opened[0]?.model).toBeUndefined();
  });

  it("[law 1] a member's per-recipe delegate pin still selects the delegate variant", async () => {
    const { outcome } = await fire({
      manifest: manifest({
        enrich: {
          ...ocrEnrich,
          delegateStep: { ...DELEGATE_STEP, selected: "delegate" },
        },
        model: "manifest/pin",
      }),
      resolveEnrichPolicy: cascade("built-in", { kind: "built-in" }),
    });

    expect(injectedInput(outcome)).toStrictEqual({
      variant: "delegate",
      profileId: "built-in",
      delegateModel: "manifest/pin",
    });
  });

  it("[law 2] a delegate profile selects the delegate variant and carries its binding", async () => {
    const { outcome, opened } = await fire({
      manifest: manifest({ enrich: ocrEnrich }),
      resolveEnrichPolicy: cascade("vision-pro", {
        kind: "delegate",
        harness: "codex",
        model: "owner/pin",
        configPins: { thought_level: "high" },
        promptRev: "ocr-v1",
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(injectedInput(outcome)).toStrictEqual({
      variant: "delegate",
      profileId: "vision-pro",
      delegateModel: "owner/pin",
      delegateHarness: "codex",
      delegateConfigPins: { thought_level: "high" },
      promptRev: "ocr-v1",
    });
    expect(opened[0]?.model).toBe("owner/pin");
    expect(opened[0]?.configPins).toStrictEqual({ thought_level: "high" });
  });

  it("[law 2] a profile that names no model falls back to the manifest's pin", async () => {
    const { outcome } = await fire({
      manifest: manifest({ enrich: ocrEnrich, model: "manifest/pin" }),
      resolveEnrichPolicy: cascade("vision-pro", {
        kind: "delegate",
        harness: "codex",
      }),
    });

    expect(injectedInput(outcome)).toStrictEqual({
      variant: "delegate",
      profileId: "vision-pro",
      delegateModel: "manifest/pin",
      delegateHarness: "codex",
    });
  });

  it("[law 3] refuses a delegate profile with no pinned model anywhere, opening no dispatch", async () => {
    const { outcome, opened } = await fire({
      manifest: manifest({ enrich: ocrEnrich }),
      resolveEnrichPolicy: cascade("vision-pro", {
        kind: "delegate",
        harness: "codex",
      }),
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("requires an explicit pinned model");
    expect(opened).toStrictEqual([]);
  });

  it("[law 4] a delegate profile is inert for a capability whose handler has no delegate variant", async () => {
    const { outcome, opened, logs } = await fire({
      manifest: manifest({
        enrich: { domain: "docs", capability: "embed-text", lane: "device" },
      }),
      resolveEnrichPolicy: cascade("text-vlm", {
        kind: "delegate",
        harness: "codex",
        model: "owner/pin",
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(injectedInput(outcome)).toBeNull();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.model).toBeUndefined();
    expect(
      logs.some((line) => line.includes("declares no delegate variant"))
    ).toBe(true);
  });

  it("[law 4] the same holds for faces, which admits no delegate engine at all", async () => {
    const { outcome, opened } = await fire({
      manifest: manifest({
        enrich: { domain: "photos", capability: "faces", lane: "device" },
      }),
      resolveEnrichPolicy: cascade("face-vlm", {
        kind: "delegate",
        harness: "codex",
        model: "owner/pin",
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(injectedInput(outcome)).toBeNull();
    expect(opened[0]?.model).toBeUndefined();
  });

  it("reads the engine registry only for the profile the cascade selected", async () => {
    const asked: string[] = [];
    await fire({
      manifest: manifest({ enrich: ocrEnrich }),
      resolveEnrichPolicy: (request) => ({
        tier: "gateway",
        rules: [
          {
            scope: { type: "domain", ref: request.domain },
            capability: request.capability,
            enabled: true,
            profile: "vision-pro",
            trigger: null,
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
        ],
        egressForProfile: () => "gateway",
        engineForProfile: (profileId: string) => {
          asked.push(profileId);
          return { kind: "built-in" };
        },
      }),
    });

    expect(asked).toStrictEqual(["vision-pro"]);
  });

  it("never reads the engine of a refused run", async () => {
    const asked: string[] = [];
    const { outcome } = await fire({
      manifest: manifest({ enrich: ocrEnrich }),
      resolveEnrichPolicy: () => ({
        tier: "off",
        rules: [],
        egressForProfile: () => "gateway",
        engineForProfile: (profileId: string) => {
          asked.push(profileId);
          return { kind: "delegate", harness: "codex", model: "owner/pin" };
        },
        egressConsent: () => null,
      }),
    });

    expect(outcome.skipped).toBe(true);
    expect(asked).toStrictEqual([]);
  });
});
