/*
 * The enrichment tier, end to end: OWNER CONTROL → vault → mirror → gate.
 *
 * The gate (decision S9) is enforced on the execution path, and the
 * `off | device | gateway` axis (issue #712 C5, renamed from
 * `off | local | model`) is the whole of what it enforces — there is no
 * separate `provider` tier; provider egress is gated per call (#567) and
 * per capability (S9's own consent read), independently of this tier. That
 * enforcement is only honest if the owner can actually move the tier, so the
 * law this file states is the whole loop: what Settings → Enrichment writes
 * is what `decideEnrichmentGate` later reads, with the app-readable mirror in
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
    // issue #712 C5: the bootstrap default moved from `local` (refuses every
    // gateway-lane enricher) to `gateway` (allows the domain to reach the
    // lane a manifest declares). Each shipped enricher still starts
    // `enabled: false` in its own manifest, so this tier widens what an
    // install COULD run, not what runs unasked.
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
    // Device-lane work is untouched by the drop — `device` still permits the
    // deterministic and device-lease lane, with model turns sealed.
    expect(gateFor("device")).toStrictEqual({
      allowed: true,
      sealModelTurns: true,
    });
  });

  it("law: each domain moves alone — raising photos never raises documents", () => {
    updateEnrichSettings(db, { photos: "gateway" });

    expect(readEnrichPolicyTier(db.vault, "photos")).toBe("gateway");
    // `docs` still carries the bootstrap default, unmoved by the photos write.
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

  // [C5 SABOTAGE TEST] the gate half of the migration law pinned in
  // `packages/vault/src/enrich/enrich.test.ts` ("a legacy 'local' row reads
  // as device, not gateway"). That file proves the READ; this proves the
  // READ actually reaches the ENFORCED gate, end to end, because this is
  // the one package that depends on both `@centraid/vault` and
  // `@centraid/automation`.
  //
  // THE SABOTAGE TARGET: map `LEGACY_TIER.local` to `"gateway"` in
  // `packages/vault/src/enrich/policy.ts` (or in `host.ts`'s copy) and the
  // first assertion below goes green when it must be red — a vault that
  // said "local" (no model turn, ever) would silently start allowing
  // gateway-lane fires the instant this build was deployed, with no owner
  // action and no consent gate in between.
  it("[C5 sabotage] a vault at the legacy 'local' tier produces no gateway-lane fire until the owner raises it", () => {
    // Simulate a vault that predates the #712 rename: write the pre-rename
    // value straight into the mirror row, standing in for a physical file
    // whose last write happened under the old build.
    db.vault
      .prepare(
        "UPDATE enrich_policy SET tier = 'local' WHERE domain = 'photos'"
      )
      .run();

    // No face proposal path runs: the migrated read is the conservative
    // `device`, and `device` cannot reach the `gateway` lane a real
    // the enricher manifest declares.
    const before = gateFor("gateway");
    expect(before.allowed).toBe(false);

    // The one gate that IS wired on this execution path today is the
    // domain tier, and it is answered the same way Settings → Enrichment
    // answers it: an explicit owner write, not a migration default.
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

  it("law: the card names the tier in force and points at the control", () => {
    const device = enrichRefusalNotice({ domain: "photos", tier: "device" });
    expect(device.kind).toBe("enrichment");
    expect(device.sourceRef).toBe("photos");
    expect(device.headline).toContain("limited to your devices");
    expect(device.detail?.deepLink).toBe("/settings/enrichment");
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
