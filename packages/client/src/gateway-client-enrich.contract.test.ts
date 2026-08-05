// Client↔gateway seam laws for the enrichment tier — the owner's only write
// path to the setting the runtime gate enforces (decision S9). Two laws carry
// the design: the write is a PATCH-shaped PUT that names ONE domain (so a
// single consent answer can never raise a domain the member did not look at),
// and the client renders the tiers the GATEWAY reports back, never the ones it
// asked for. Shared harness in gateway-client-seam-fixtures.ts.

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
      docs: "local",
      photos: "local",
    });
    expect(sent("GET /centraid/_vault/enrich").method).toBe("GET");
  });

  it("law: a write names exactly the domain the member changed", async () => {
    await vaultOwner.setEnrichPolicy({ photos: "model" });

    expect(sentJson("PUT /centraid/_vault/enrich")).toStrictEqual({
      photos: "model",
    });
  });

  it("law: the caller gets the vault's state back, not the patch it sent", async () => {
    // A gateway that refused to raise the tier (an unwritable vault, a policy
    // the route coerced) must not leave the client rendering "model".
    respond("PUT /centraid/_vault/enrich", () =>
      json({ enrich: { docs: "local", photos: "local" } })
    );

    await expect(
      vaultOwner.setEnrichPolicy({ photos: "model" })
    ).resolves.toStrictEqual({ docs: "local", photos: "local" });
  });

  it("law: a rejected tier is a thrown write, never a silent no-op", async () => {
    respond("PUT /centraid/_vault/enrich", () =>
      json({ error: "bad_request", message: "photos must be…" }, 400)
    );

    await expect(
      vaultOwner.setEnrichPolicy({ photos: "model" })
    ).rejects.toThrow(/enrichment policy/u);
  });
});
