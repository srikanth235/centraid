// Client↔gateway seam laws for the enrichment tier — the owner's only write
// path to the setting the runtime gate enforces (decision S9). Two laws carry
// the design: the write is a PATCH-shaped PUT that names ONE domain (so a
// single consent answer can never raise a domain the member did not look at),
// and the client renders the tiers the GATEWAY reports back, never the ones it
// asked for. Shared harness in gateway-client-seam-fixtures.ts.
//
// Tier vocabulary is `off | device | gateway` (issue #712 C5, renamed from
// `off | local | model`).

import { describe, expect, it } from "vitest";

import {
  installSeamContractHarness,
  json,
  respond,
  sent,
  sentJson,
  vaultOwner,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

describe("enrichment tier seam", () => {
  it("law: the tier is read from the owner-plane route, per domain", async () => {
    await expect(vaultOwner.getEnrichPolicy()).resolves.toStrictEqual({
      docs: "gateway",
      photos: "gateway",
    });
    expect(sent("GET /centraid/_vault/enrich").method).toBe("GET");
  });

  it("law: a write names exactly the domain the member changed", async () => {
    await vaultOwner.setEnrichPolicy({ photos: "device" });

    expect(sentJson("PUT /centraid/_vault/enrich")).toStrictEqual({
      photos: "device",
    });
  });

  it("law: the caller gets the vault's state back, not the patch it sent", async () => {
    // A gateway that refused to lower the tier (an unwritable vault, a
    // policy the route coerced) must not leave the client rendering
    // "device".
    respond("PUT /centraid/_vault/enrich", () =>
      json({ enrich: { docs: "gateway", photos: "gateway" } })
    );

    await expect(
      vaultOwner.setEnrichPolicy({ photos: "device" })
    ).resolves.toStrictEqual({ docs: "gateway", photos: "gateway" });
  });

  it("law: a rejected tier is a thrown write, never a silent no-op", async () => {
    respond("PUT /centraid/_vault/enrich", () =>
      json({ error: "bad_request", message: "photos must be…" }, 400)
    );

    await expect(
      vaultOwner.setEnrichPolicy({ photos: "device" })
    ).rejects.toThrow(/enrichment policy/u);
  });
});

// The policy CASCADE (issue #807), layered over the tier above. Its laws are
// the tier's laws, restated for a scoped rule: the caller renders what the
// VAULT holds, and the effective answer is a REPORT of what the one runtime
// gate would resolve — never permission the client may act on itself.
describe("enrichment cascade seam", () => {
  it("law: the rules ride the same read as the tiers, additively", async () => {
    // The tier read is unchanged by the cascade — same route, same shape.
    await expect(vaultOwner.getEnrichPolicy()).resolves.toStrictEqual({
      docs: "gateway",
      photos: "gateway",
    });

    await expect(vaultOwner.getEnrichRules()).resolves.toStrictEqual([
      {
        scope: { type: "domain", ref: "photos" },
        capability: "ocr",
        enabled: null,
        profile: null,
        trigger: "on-view",
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
    ]);
  });

  it("law: a rule write names one scope and one capability, and reads back the vault's row", async () => {
    const written = await vaultOwner.setEnrichRule({
      scope: "collection",
      ref: "album-1",
      capability: "ocr",
      trigger: "on-demand",
    });

    expect(sentJson("PUT /centraid/_vault/enrich/rules")).toStrictEqual({
      scope: "collection",
      ref: "album-1",
      capability: "ocr",
      trigger: "on-demand",
    });
    // What came back is the gateway's row, not the patch.
    expect(written?.scope).toStrictEqual({
      type: "collection",
      ref: "album-1",
    });
  });

  it("law: dropping a rule is keyed by scope + capability in the query", async () => {
    await vaultOwner.deleteEnrichRule("collection", "album-1", "ocr");

    const request = sent("DELETE /centraid/_vault/enrich/rules");
    expect(request.method).toBe("DELETE");
    expect(Object.fromEntries(request.query)).toStrictEqual({
      scope: "collection",
      ref: "album-1",
      capability: "ocr",
    });
  });

  it("law: the effective read carries the deeper scopes the caller named", async () => {
    const answer = await vaultOwner.getEffectiveEnrichPolicy({
      domain: "photos",
      capability: "ocr",
      scopes: [{ type: "item", ref: "asset-9" }],
    });

    const request = sent("GET /centraid/_vault/enrich/effective");
    expect(request.query.getAll("scope")).toStrictEqual(["item:asset-9"]);
    expect(answer.effective?.egressCeiling).toBe("on-device");
  });

  it("law: a refused rule write throws, never a silent no-op", async () => {
    respond("PUT /centraid/_vault/enrich/rules", () =>
      json({ error: "bad_request", message: "capability must be…" }, 400)
    );

    await expect(
      vaultOwner.setEnrichRule({
        scope: "vault",
        capability: "nope",
        enabled: true,
      })
    ).rejects.toThrow(/enrichment rule/u);
  });
});

// The EGRESS-CONSENT ledger (issue #807, Wave 3). Its seam laws are the
// cascade's, one turn stricter: the client only ever READS the ledger and
// POSTS an answer to it — the rows themselves are written by the vault's one
// journalled command — and a decline is carried back exactly like a grant,
// because a consent surface that only reported the yeses would be a record of
// half the answers.
describe("enrichment egress-consent seam", () => {
  it("law: the ledger is read whole from the owner plane, declines included", async () => {
    await expect(vaultOwner.listEnrichEgressConsent()).resolves.toStrictEqual([
      {
        capability: "faces",
        egress: "provider",
        scopeRef: "",
        decision: "declined",
        decidedAt: "2026-08-15T10:00:00.000Z",
        receiptId: null,
      },
    ]);
    expect(sent("GET /centraid/_vault/enrich/consent").method).toBe("GET");
  });

  it("law: an answer names one capability, one egress class and one decision", async () => {
    const recorded = await vaultOwner.recordEnrichEgressConsent({
      capability: "faces",
      egress: "provider",
      decision: "granted",
    });

    expect(sentJson("POST /centraid/_vault/enrich/consent")).toStrictEqual({
      capability: "faces",
      egress: "provider",
      decision: "granted",
    });
    // What came back is the vault's row, not the answer that was sent.
    expect(recorded?.decidedAt).toBe("2026-08-16T00:00:00.000Z");
  });

  it("law: an answer the vault refused throws, never a silent grant", async () => {
    respond("POST /centraid/_vault/enrich/consent", () =>
      json({ error: "not_recorded", message: "parked for the owner" }, 409)
    );

    await expect(
      vaultOwner.recordEnrichEgressConsent({
        capability: "faces",
        egress: "provider",
        decision: "granted",
      })
    ).rejects.toThrow(/egress consent/u);
  });
});
