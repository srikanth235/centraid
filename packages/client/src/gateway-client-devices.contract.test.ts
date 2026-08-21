// Client↔gateway seam laws for the pairing-ticket mint route (#726, #726 P1)
// — the module had no test file (#656 Layer 1B). States the wire shape of
// the two mutually exclusive mint lanes: self-pair (unchanged from P0) and
// "Add someone" (`forPerson`, P1), which lands the ticket on a freshly minted
// owner+vault instead of the caller's own. Shared harness in
// gateway-client-seam-fixtures.ts.

import { describe, expect, it } from "vitest";

import {
  devices,
  installSeamContractHarness,
  json,
  respond,
  sentJson,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

describe("pairing-ticket mint seam", () => {
  it("law: self-pair rides the documented route with no forPerson field", async () => {
    await expect(
      devices.createGatewayDeviceTicket({ ttlMinutes: 15 })
    ).resolves.toMatchObject({
      ticket: "CENTRAID-TICKET-SELF",
      ownerId: "o-1",
      ownerLabel: "Ada",
    });

    expect(wireLog()).toStrictEqual(["POST /centraid/_gateway/devices/ticket"]);
    expect(sentJson("POST /centraid/_gateway/devices/ticket")).toStrictEqual({
      ttlMinutes: 15,
    });
  });

  it("law: Add someone sends forPerson and nothing from the self-pair lane", async () => {
    await devices.createGatewayDeviceTicket({
      forPerson: { label: "Priya" },
      ttlMinutes: 60,
    });

    const sent = sentJson("POST /centraid/_gateway/devices/ticket");
    expect(sent).toStrictEqual({
      forPerson: { label: "Priya" },
      ttlMinutes: 60,
    });
    // Mutually exclusive with the self-pair lane (#726 P1): no vaultId/vaultIds
    // rides alongside a forPerson mint.
    expect(sent.vaultId).toBeUndefined();
    expect(sent.vaultIds).toBeUndefined();
  });

  it("law: Add someone's response carries the NEWLY MINTED owner+vault, not the caller's", async () => {
    const ticket = await devices.createGatewayDeviceTicket({
      forPerson: { label: "Priya", vaultName: "Priya's vault" },
    });

    expect(ticket).toMatchObject({
      ownerId: "o-new",
      ownerLabel: "Priya",
      vaultId: "v-new",
      vaultName: "Priya's vault",
      vaults: [{ vaultId: "v-new", vaultName: "Priya's vault" }],
    });
  });
});

describe("device-work status seam", () => {
  it("degrades a gateway response without vaults to an empty work list", async () => {
    respond("GET /centraid/_gateway/device-work/status", () => json({}));

    await expect(devices.getGatewayDeviceWorkStatus()).resolves.toStrictEqual(
      []
    );
  });
});
