/*
 * The enrichment tier, end to end: OWNER CONTROL → vault → mirror → gate.
 *
 * The gate (decision S9) is enforced on the execution path, and the seeded
 * default refuses every model-routed enricher. That enforcement is only
 * honest if the owner can actually move the tier, so the law this file states
 * is the whole loop: what Settings → Enrichment writes is what
 * `decideEnrichmentGate` later reads, with the app-readable mirror in
 * between. Gateway is the one package that depends on BOTH halves, which is
 * why the loop is pinned here rather than in vault or automation alone.
 *
 * `updateEnrichSettings` is exercised directly — it is the authoritative
 * writer that `PUT /centraid/_vault/enrich` calls, and the client control
 * reaches it through no other path.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { decideEnrichmentGate } from "@centraid/automation";
import type { EnrichLane, EnrichTier } from "@centraid/automation";
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

/** The gate as the fire spine applies it: tier read off the vault, not passed in. */
function gateFor(lane: EnrichLane): ReturnType<typeof decideEnrichmentGate> {
  const tier = readEnrichPolicyTier(db.vault, "photos");
  return decideEnrichmentGate({
    automationRef: "photos/face-proposer",
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

  it("law: a fresh scope refuses model-lane enrichment until the owner raises the tier", () => {
    expect(readEnrichPolicyTier(db.vault, "photos")).toBe("local");
    const before = gateFor("model");
    expect(before.allowed).toBe(false);

    updateEnrichSettings(db, { photos: "model" });

    const after = gateFor("model");
    expect(after).toStrictEqual({ allowed: true, sealModelTurns: false });
  });

  it("law: the control's write reaches the mirror the gate reads, for every tier", () => {
    const seen: EnrichTier[] = [];
    for (const tier of ["off", "model", "local"] as const) {
      updateEnrichSettings(db, { photos: tier });
      const mirrored = readEnrichPolicyTier(db.vault, "photos");
      expect(mirrored).toBe(tier);
      if (mirrored) seen.push(mirrored);
    }
    expect(seen).toStrictEqual(["off", "model", "local"]);
  });

  it("law: lowering the tier back re-seals model turns — consent is not one-way", () => {
    updateEnrichSettings(db, { photos: "model" });
    expect(gateFor("model").allowed).toBe(true);

    updateEnrichSettings(db, { photos: "local" });

    expect(gateFor("model").allowed).toBe(false);
    // Device-lane work is untouched by the drop — `local` still permits the
    // deterministic and device-lease lane, with model turns sealed.
    expect(gateFor("device")).toStrictEqual({
      allowed: true,
      sealModelTurns: true,
    });
  });

  it("law: each domain moves alone — raising photos never raises documents", () => {
    updateEnrichSettings(db, { photos: "model" });

    expect(readEnrichPolicyTier(db.vault, "photos")).toBe("model");
    expect(readEnrichPolicyTier(db.vault, "docs")).toBe("local");
  });

  it("law: `off` refuses the device lane too, not only model turns", () => {
    updateEnrichSettings(db, { photos: "off" });

    expect(gateFor("device").allowed).toBe(false);
    expect(gateFor("model").allowed).toBe(false);
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

  it("law: the card names the tier in force and points at the control", () => {
    const local = enrichRefusalNotice({ domain: "photos", tier: "local" });
    expect(local.kind).toBe("enrichment");
    expect(local.sourceRef).toBe("photos");
    expect(local.headline).toContain("limited to your devices");
    expect(local.detail?.deepLink).toBe("/settings/enrichment");
    expect(local.detail?.enrichDomain).toBe("photos");
  });

  it("law: a refusal never wakes a device — only `high` does, and this is not that", () => {
    for (const tier of ["off", "local", "model"]) {
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
    expect(shouldWriteEnrichRefusalNotice(undefined, "local")).toBe(true);
    expect(shouldWriteEnrichRefusalNotice(priorFor("local"), "local")).toBe(
      false
    );
    expect(shouldWriteEnrichRefusalNotice(priorFor("local"), "off")).toBe(true);
    expect(shouldWriteEnrichRefusalNotice(priorFor(undefined), "local")).toBe(
      true
    );
  });
});
