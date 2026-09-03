import { describe, expect, it } from "vitest";

import {
  edges,
  installSeamContractHarness,
  json,
  respond,
  sentJson,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

const RECOVERY = "/centraid/_gateway/commons/recovery";

describe("commons recovery seam", () => {
  it("law: the presence read names the actor vault and keeps the answer attributable", async () => {
    const grants = await edges.listCommonsRecovery("vault-1");

    expect(wireLog()).toStrictEqual([`GET ${RECOVERY}`]);
    expect(grants).toStrictEqual([
      {
        actorVaultId: "vault-1",
        grantId: "grant-1",
        containerType: "album",
        steward: expect.objectContaining({
          presence: "absent",
          stewardVaultId: "vault-gone",
        }),
      },
    ]);
  });

  it("law: a vault with no commons reads as no concerns, never as a failure", async () => {
    respond(`GET ${RECOVERY}`, () => json({ vaultId: "vault-1" }));

    await expect(edges.listCommonsRecovery("vault-1")).resolves.toStrictEqual(
      []
    );
  });

  it("law: the ceremony posts the actor vault and grant, and reports delivery per seat", async () => {
    const outcome = await edges.recoverCommons("vault-1", "grant-1");

    expect(wireLog()).toStrictEqual([`POST ${RECOVERY}`]);
    expect(sentJson(`POST ${RECOVERY}`)).toStrictEqual({
      actorVaultId: "vault-1",
      grantId: "grant-1",
    });
    expect(outcome.state).toBe("recovered");
    expect(outcome.invitations).toStrictEqual([
      { partyId: "party-b", memberVaultId: "vault-b", state: "delivered" },
      { partyId: "party-c", state: "claim" },
    ]);
  });

  it("law: a named refusal arrives as plain words, not a status code or raw body", async () => {
    respond(`POST ${RECOVERY}`, () =>
      json({ state: "refused", reason: "parked-on-fault" }, 409)
    );

    await expect(edges.recoverCommons("vault-1", "grant-1")).rejects.toThrow(
      /could not be verified/u
    );
  });

  it("law: an unmapped refusal still reaches the member with its reason", async () => {
    respond(`POST ${RECOVERY}`, () =>
      json({ state: "refused", reason: "brand-new-reason" }, 409)
    );

    await expect(edges.recoverCommons("vault-1", "grant-1")).rejects.toThrow(
      /brand-new-reason/u
    );
  });
});
