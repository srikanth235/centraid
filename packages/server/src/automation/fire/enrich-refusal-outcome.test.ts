import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { ledgerDbFileIn } from "../../engine/stores/ledger-db.test-fixtures.js";
import type { Manifest } from "../manifest/manifest.js";
import type { EnrichLane, EnrichTier } from "./enrich-gate.js";
import { runFire } from "./fire.js";
import type { DispatchSurface } from "./fire.js";

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

describe("enrichment refusal, as the host receives it", () => {
  let appsDir: string;
  let ledgerDbFile: string;

  beforeEach(async () => {
    appsDir = await tempDir("centraid-enrich-refusal-");
    ledgerDbFile = ledgerDbFileIn(appsDir);
    const dir = path.join(appsDir, "photos", "automations", "face-finder");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "automation.json"),
      JSON.stringify(enricherManifest("gateway"), null, 2)
    );
    await fs.writeFile(
      path.join(dir, "handler.js"),
      "export default async () => ({ ok: true });"
    );
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  const dispatch = (): Promise<DispatchSurface> =>
    Promise.resolve({
      delegateDispatcher: () => Promise.resolve("a model answer"),
      close: () => Promise.resolve(),
    });

  async function fire(tier: EnrichTier | undefined) {
    return runFire(
      {
        appsDir,
        automationRef: "photos/face-finder",
        ledgerDbFile,
        resolveEnrichPolicy: () => tier,
      },
      { openDispatch: dispatch }
    );
  }

  it("law: a tier refusal carries the domain, the capability, and the tier in force", async () => {
    const { outcome } = await fire("device");

    expect(outcome.skipped).toBe(true);
    expect(outcome.enrichRefusal).toStrictEqual({
      capability: "faces",
      domain: "photos",
      tier: "device",
    });
  });

  it("law: an UNREADABLE policy reports no tier rather than inventing one", async () => {
    const { outcome } = await fire(undefined);

    expect(outcome.skipped).toBe(true);
    expect(outcome.enrichRefusal).toStrictEqual({
      capability: "faces",
      domain: "photos",
    });
    expect(outcome.enrichRefusal?.tier).toBeUndefined();
  });

  it("law: an ALLOWED fire carries no refusal — the card is raised only on refusal", async () => {
    const { outcome } = await fire("gateway");

    expect(outcome.skipped).toBeUndefined();
    expect(outcome.enrichRefusal).toBeUndefined();
  });
});
