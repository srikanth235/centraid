import { describe, afterEach, expect, test } from "vitest";

import { parsePairingTicket } from "../serve/pairing-store.js";
import {
  cleanupHarnesses,
  deviceHeaders,
  harness,
} from "./devices-routes.test-fixtures.js";

describe("devices-routes-invitations scenarios", () => {
  afterEach(cleanupHarnesses);

  test("minting splits by target: self-pair is open, another person is refused", async () => {
    const f = await harness({
      vaultName: (id) => ({ "vault-a": "Personal", "vault-b": "Work" })[id],
    });
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a", "vault-b"],
      label: "Owner",
      ownerLabel: "Priya",
    });
    const body = JSON.stringify({ vaultId: "vault-a" });
    const anonymous = await fetch(
      `${f.base}/centraid/_gateway/devices/ticket`,
      {
        method: "POST",
        body,
      }
    );
    expect(anonymous.status).toBe(403);

    const selfPair = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("owner-key"),
      body,
    });
    expect(selfPair.status).toBe(200);
    await expect(selfPair.json()).resolves.toMatchObject({
      ownerId: owner.ownerId,
      ownerLabel: "Priya",
      vaultId: "vault-a",
    });

    const denied = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({ vaultId: "vault-a", newOwnerLabel: "Kid" }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: "owner_vaults_only",
    });

    const minted = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("owner-key"),
      body,
    });
    expect(minted.status).toBe(200);
    const payload = (await minted.json()) as { ticket: string };
    const parsed = parsePairingTicket(payload.ticket);
    expect(parsed).toBeDefined();
    if (!parsed) throw new Error("ticket did not parse");
    expect(parsed.gw).toBe("endpoint-ticket");
    expect(f.tickets.redeem(parsed.t, parsed.s)).toMatchObject({
      ownerId: owner.ownerId,
      vaultIds: ["vault-a", "vault-b"],
    });
  });

  test("a named non-primary target becomes the ticket's landing vault", async () => {
    const f = await harness({
      vaultName: (id) => ({ "vault-a": "Personal", "vault-b": "Work" })[id],
    });
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a", "vault-b"],
      label: "Owner",
      ownerLabel: "Priya",
    });

    const minted = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({ vaultId: "vault-b" }),
    });
    expect(minted.status).toBe(200);
    const payload = (await minted.json()) as { ticket: string };
    const parsed = parsePairingTicket(payload.ticket);
    if (!parsed) throw new Error("ticket did not parse");
    expect(f.tickets.redeem(parsed.t, parsed.s)).toMatchObject({
      ownerId: owner.ownerId,
      vaultIds: ["vault-b", "vault-a"],
    });
  });

  test("an explicit vaultIds list is bounded by what the owner owns", async () => {
    const f = await harness({
      vaultName: (id) =>
        ({ "vault-a": "Personal", "vault-c": "Elsewhere" })[id],
    });
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Owner",
      ownerLabel: "Priya",
    });
    f.enrollments.enroll({
      endpointId: "other-key",
      vaultIds: ["vault-c"],
      label: "Other",
      ownerLabel: "Sid",
    });

    const outside = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({ vaultIds: ["vault-c"] }),
    });
    expect(outside.status).toBe(404);
    await expect(outside.json()).resolves.toMatchObject({
      error: "not_found",
    });

    const malformed = await fetch(
      `${f.base}/centraid/_gateway/devices/ticket`,
      {
        method: "POST",
        headers: deviceHeaders("owner-key"),
        body: JSON.stringify({ vaultIds: [42] }),
      }
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: "invalid_vault_ids",
    });
  });

  test("minting a ticket with no resolvable vault answers vault_required", async () => {
    const f = await harness();
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-b"],
      label: "Owner",
    });
    const anonymousVault = await fetch(
      `${f.base}/centraid/_gateway/devices/ticket`,
      {
        method: "POST",
        headers: deviceHeaders("owner-key"),
        body: JSON.stringify({}),
      }
    );
    expect(anonymousVault.status).toBe(404);

    const noVaults = await harness();
    noVaults.enrollments.enroll({
      endpointId: "lonely-key",
      vaultIds: ["vault-a"],
      label: "Owner",
    });
    const unknownTarget = await fetch(
      `${noVaults.base}/centraid/_gateway/devices/ticket`,
      {
        method: "POST",
        headers: deviceHeaders("lonely-key"),
        body: JSON.stringify({ vaultId: "no-such-vault" }),
      }
    );
    expect(unknownTarget.status).toBe(400);
    await expect(unknownTarget.json()).resolves.toMatchObject({
      error: "vault_required",
    });
  });

  test("a gateway with no iroh endpoint refuses to mint a dud ticket", async () => {
    const f = await harness({ endpointTicket: () => undefined });
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Owner",
    });
    const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({ vaultId: "vault-a" }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "no_iroh_endpoint",
    });
  });

  test("an unnamed target mints against the registry default vault (Personal)", async () => {
    const f = await harness({
      vaultName: (vaultId) =>
        vaultId === "vault-a"
          ? "Shared"
          : vaultId === "vault-personal"
            ? "Personal"
            : undefined,
      defaultVaultId: () => "vault-personal",
    });
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a", "vault-personal"],
      label: "Owner",
    });
    const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      vaultId: "vault-personal",
      vaultName: "Personal",
    });
  });

  test("a default the caller cannot address falls back to a vault it holds", async () => {
    const f = await harness({ defaultVaultId: () => "vault-someone-else" });
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Owner",
    });
    const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      vaultId: "vault-a",
    });
  });

  test("host custody mints for the vault's existing owner; a new person is refused", async () => {
    const f = await harness({
      canMintPairingTicket: () => true,
      vaultIds: () => ["vault-a"],
    });
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Owner laptop",
      ownerLabel: "Priya",
    });
    const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ownerId: owner.ownerId,
      ownerLabel: "Priya",
      vaults: [{ vaultId: "vault-a", vaultName: "Personal" }],
    });

    const newPerson = await fetch(
      `${f.base}/centraid/_gateway/devices/ticket`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newOwnerLabel: "Kid" }),
      }
    );
    expect(newPerson.status).toBe(403);
    await expect(newPerson.json()).resolves.toMatchObject({
      error: "owner_vaults_only",
    });
  });
});
