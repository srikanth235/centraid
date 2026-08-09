// Client↔gateway seam laws for the owner surface (#726) — the module had no
// test file (#656 Layer 1B). Two laws carry the design: a gateway with no
// device plane (the desktop embed) has no roster and must read as EMPTY
// rather than as a failure, and the roster a device caller sees is exactly
// its own person — topology hiding, re-aimed. Shared harness in
// gateway-client-seam-fixtures.ts.

import { describe, expect, it } from "vitest";

import {
  installSeamContractHarness,
  json,
  owners,
  respond,
  sentJson,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

describe("owner surface seam", () => {
  it("law: each verb rides its documented route and method", async () => {
    await expect(owners.listGatewayOwners()).resolves.toMatchObject([
      { ownerId: "o-1", label: "Ada", deviceCount: 2 },
    ]);
    await expect(
      owners.renameGatewayOwner("o-1", "Ada L")
    ).resolves.toMatchObject({ ownerId: "o-1", label: "Ada L" });

    expect(wireLog()).toStrictEqual([
      "GET /centraid/_gateway/owners",
      "PATCH /centraid/_gateway/owners/o-1",
    ]);
  });

  it("law: a gateway with no device plane reports an empty roster, not a failure", async () => {
    respond(
      "GET /centraid/_gateway/owners",
      () => new Response("no device plane", { status: 404 })
    );

    await expect(owners.listGatewayOwners()).resolves.toStrictEqual([]);
  });

  it("law: only the missing-plane 404 is swallowed — every other failure reaches the UI", async () => {
    respond(
      "GET /centraid/_gateway/owners",
      () => new Response("nope", { status: 403 })
    );

    await expect(owners.listGatewayOwners()).rejects.toMatchObject({
      code: "auth_required",
    });
  });

  it("law: an absent owners array reads as an empty roster", async () => {
    respond("GET /centraid/_gateway/owners", () => json({}));

    await expect(owners.listGatewayOwners()).resolves.toStrictEqual([]);
  });

  it("law: an owner id is percent-encoded into the path, never interpolated raw", async () => {
    respond("PATCH /centraid/_gateway/owners/o%2F1", () =>
      json({ owner: { ownerId: "o/1", label: "Ada" } })
    );

    await expect(
      owners.renameGatewayOwner("o/1", "Ada")
    ).resolves.toMatchObject({ ownerId: "o/1" });
    expect(wireLog()).toStrictEqual(["PATCH /centraid/_gateway/owners/o%2F1"]);
  });

  it("law: a rename sends only the label", async () => {
    await owners.renameGatewayOwner("o-1", "Ada L");

    expect(sentJson("PATCH /centraid/_gateway/owners/o-1")).toStrictEqual({
      label: "Ada L",
    });
  });
});
