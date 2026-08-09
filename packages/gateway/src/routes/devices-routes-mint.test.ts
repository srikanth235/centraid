/*
 * *Add someone* — the mint ceremony on `POST /centraid/_gateway/devices/ticket`
 * (issue #726 P1): `body.forPerson` creates a new owner, mints them a vault
 * of their own (identity keypair included — `VaultRegistry.create`), claims
 * it, and mints a ticket bound to that NEW owner. Mutually exclusive with
 * the P0 self-pair `ownerId`/`vaultIds` lane.
 */

import { describe, afterEach, expect, test } from "vitest";

import { parsePairingTicket } from "../serve/pairing-store.js";
import {
  cleanupHarnesses,
  deviceHeaders,
  harness,
} from "./devices-routes.test-fixtures.js";

/** A `mintVaultForPerson` stub: hands out fresh ids and remembers names so
 *  the harness's `vaultName` can resolve them right back. */
function mintStub(): {
  vaultNames: Map<string, string>;
  mintVaultForPerson: (name: string) => { vaultId: string };
} {
  const vaultNames = new Map<string, string>([["vault-a", "Personal"]]);
  let minted = 0;
  return {
    vaultNames,
    mintVaultForPerson: (name) => {
      minted += 1;
      const vaultId = `minted-vault-${minted}`;
      vaultNames.set(vaultId, name);
      return { vaultId };
    },
  };
}

describe("devices-routes mint-for-person scenarios (#726 P1)", () => {
  afterEach(cleanupHarnesses);

  // Exit evidence #1: add someone → ticket redeems → their device reaches
  // EXACTLY their vault (never the founder's) — "a family member scans one
  // code and has their own Photos library" (issue #726).
  test("add someone: redemption lands the new person's device in exactly their new vault", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
    });
    const founder = f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
      ownerLabel: "Priya",
    });

    const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("founder-key"),
      body: JSON.stringify({ forPerson: { label: "Kid" } }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ticket: string;
      ownerId: string;
      ownerLabel: string;
      vaultId: string;
      vaultName: string;
      vaults: Array<{ vaultId: string; vaultName?: string }>;
    };
    // A NEW owner, distinct from the founder — the whole point of the mint.
    expect(payload.ownerId).not.toBe(founder.ownerId);
    expect(payload.ownerLabel).toBe("Kid");
    // No explicit `vaultName` → "<label>'s vault".
    expect(payload.vaultName).toBe("Kid's vault");
    expect(payload.vaults).toStrictEqual([
      { vaultId: payload.vaultId, vaultName: "Kid's vault" },
    ]);

    const parsed = parsePairingTicket(payload.ticket);
    if (!parsed) throw new Error("ticket did not parse");

    const enrolled = f.tickets.redeemAndEnroll(
      parsed.t,
      parsed.s,
      f.enrollments,
      {
        endpointId: "kid-phone",
        label: "Kid's phone",
      }
    );
    expect(enrolled).toBeDefined();
    expect(enrolled!.map((row) => row.vaultId)).toStrictEqual([
      payload.vaultId,
    ]);
    expect(enrolled![0]!.ownerId).toBe(payload.ownerId);

    // Scope listing = their vault, and ONLY their vault (covers "Photos opens
    // as their library" — the app-level surface just reads this scope).
    expect(f.enrollments.vaultsFor("kid-phone")).toStrictEqual([
      payload.vaultId,
    ]);
    expect(f.enrollments.vaultsFor("kid-phone")).not.toContain("vault-a");
  });

  test("an explicit vaultName names the minted vault", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
    });
    f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
    });
    const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("founder-key"),
      body: JSON.stringify({
        forPerson: { label: "Kid", vaultName: "Kid's Library" },
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      vaultName: "Kid's Library",
    });
  });

  test("host custody may also mint for a new person", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
      canMintPairingTicket: () => true,
      vaultIds: () => ["vault-a"],
    });
    const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forPerson: { label: "Guest" } }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ownerLabel: "Guest",
    });
  });

  test("forPerson is mutually exclusive with ownerId/vaultIds and rejects malformed shapes", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
    });
    f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
    });

    const combined = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("founder-key"),
      body: JSON.stringify({
        forPerson: { label: "Kid" },
        vaultIds: ["vault-a"],
      }),
    });
    expect(combined.status).toBe(400);
    await expect(combined.json()).resolves.toMatchObject({
      error: "invalid_body",
    });

    const malformed = await fetch(
      `${f.base}/centraid/_gateway/devices/ticket`,
      {
        method: "POST",
        headers: deviceHeaders("founder-key"),
        body: JSON.stringify({ forPerson: { label: "" } }),
      }
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: "invalid_for_person",
    });
  });
});
