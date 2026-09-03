import { beforeEach, describe, expect, it } from "vitest";

import { decideEnrichmentGate } from "@centraid/server/automation";
import type { EnrichLane, EnrichTier } from "@centraid/server/automation";
import {
  bootstrapVault,
  openVaultDb,
  readEnrichPolicyTier,
  updateEnrichSettings,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import {
  enrichRefusalNotice,
  shouldWriteEnrichRefusalNotice,
} from "./notices.js";
import type { Notice } from "./notices.js";

let db: VaultDb;

function gateFor(lane: EnrichLane): ReturnType<typeof decideEnrichmentGate> {
  const tier = readEnrichPolicyTier(db.vault, "photos");
  return decideEnrichmentGate({
    automationRef: "photos/face-finder",
    capability: "faces",
    domain: "photos",
    lane,
    tier,
  });
}

describe("enrichment tier control", () => {
  beforeEach(() => {
    db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
  });

  it("law: a fresh scope's seeded gateway tier already allows gateway-lane enrichment", () => {
    expect(readEnrichPolicyTier(db.vault, "photos")).toBe("gateway");
    expect(gateFor("gateway")).toStrictEqual({
      allowed: true,
      sealModelTurns: false,
    });

    updateEnrichSettings(db, { photos: "device" });

    const after = gateFor("gateway");
    expect(after.allowed).toBe(false);
  });

  it("law: the control's write reaches the mirror the gate reads, for every tier", () => {
    const seen: EnrichTier[] = [];
    for (const tier of ["off", "gateway", "device"] as const) {
      updateEnrichSettings(db, { photos: tier });
      const mirrored = readEnrichPolicyTier(db.vault, "photos");
      expect(mirrored).toBe(tier);
      if (mirrored) seen.push(mirrored);
    }
    expect(seen).toStrictEqual(["off", "gateway", "device"]);
  });

  it("law: lowering the tier back re-seals model turns — consent is not one-way", () => {
    updateEnrichSettings(db, { photos: "gateway" });
    expect(gateFor("gateway").allowed).toBe(true);

    updateEnrichSettings(db, { photos: "device" });

    expect(gateFor("gateway").allowed).toBe(false);
    expect(gateFor("device")).toStrictEqual({
      allowed: true,
      sealModelTurns: true,
    });
  });

  it("law: each domain moves alone — raising photos never raises documents", () => {
    updateEnrichSettings(db, { photos: "gateway" });

    expect(readEnrichPolicyTier(db.vault, "photos")).toBe("gateway");
    expect(readEnrichPolicyTier(db.vault, "docs")).toBe("gateway");
    updateEnrichSettings(db, { docs: "off" });
    expect(readEnrichPolicyTier(db.vault, "docs")).toBe("off");
    expect(readEnrichPolicyTier(db.vault, "photos")).toBe("gateway");
  });

  it("law: `off` refuses the device lane too, not only gateway-lane turns", () => {
    updateEnrichSettings(db, { photos: "off" });

    expect(gateFor("device").allowed).toBe(false);
    expect(gateFor("gateway").allowed).toBe(false);
  });

  it("[C5 sabotage] a vault at the legacy 'local' tier produces no gateway-lane fire until the owner raises it", () => {
    db.vault
      .prepare(
        "UPDATE enrich_policy SET tier = 'local' WHERE domain = 'photos'"
      )
      .run();

    const before = gateFor("gateway");
    expect(before.allowed).toBe(false);

    updateEnrichSettings(db, { photos: "gateway" });

    const after = gateFor("gateway");
    expect(after).toStrictEqual({ allowed: true, sealModelTurns: false });
  });

  it("[C5] a legacy 'model' row keeps the access it already had — no narrowing", () => {
    db.vault
      .prepare(
        "UPDATE enrich_policy SET tier = 'model' WHERE domain = 'photos'"
      )
      .run();
    expect(gateFor("gateway")).toStrictEqual({
      allowed: true,
      sealModelTurns: false,
    });
  });
});

describe("enrichment refusal notice", () => {
  function priorFor(tier: string | undefined): Notice {
    const put = enrichRefusalNotice({ domain: "photos", tier });
    return {
      archivedAt: null,
      count: 1,
      detail: put.detail ?? {},
      firstAt: "2026-08-05T00:00:00.000Z",
      headline: put.headline,
      kind: put.kind,
      lastAt: "2026-08-05T00:00:00.000Z",
      noticeId: "notice-1",
      readAt: "2026-08-05T00:01:00.000Z",
      severity: put.severity ?? "info",
      sourceRef: put.sourceRef,
    };
  }

  it("law: the card names the tier in force and points at recognition automations", () => {
    const device = enrichRefusalNotice({ domain: "photos", tier: "device" });
    expect(device.kind).toBe("enrichment");
    expect(device.sourceRef).toBe("photos");
    expect(device.headline).toContain("limited to your devices");
    expect(device.detail?.deepLink).toBe("/automations");
    expect(device.detail?.enrichDomain).toBe("photos");
  });

  it("law: a refusal never wakes a device — only `high` does, and this is not that", () => {
    for (const tier of ["off", "device", "gateway"]) {
      expect(enrichRefusalNotice({ domain: "photos", tier }).severity).not.toBe(
        "high"
      );
    }
  });

  it("law: an unreadable setting reads as a fault, a chosen tier as information", () => {
    expect(enrichRefusalNotice({ domain: "docs" }).severity).toBe("warning");
    expect(enrichRefusalNotice({ domain: "docs", tier: "off" }).severity).toBe(
      "info"
    );
  });

  it("law: an unchanged refusal is not re-written, so a read card stays read", () => {
    expect(shouldWriteEnrichRefusalNotice(undefined, "device")).toBe(true);
    expect(shouldWriteEnrichRefusalNotice(priorFor("device"), "device")).toBe(
      false
    );
    expect(shouldWriteEnrichRefusalNotice(priorFor("device"), "off")).toBe(
      true
    );
    expect(shouldWriteEnrichRefusalNotice(priorFor(undefined), "device")).toBe(
      true
    );
  });
});
