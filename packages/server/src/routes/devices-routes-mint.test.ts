import { describe, afterEach, expect, test, vi } from "vitest";

import { parsePairingTicket } from "../serve/pairing-store.js";
import type { DevicesHarness } from "./devices-routes.test-fixtures.js";
import {
  cleanupHarnesses,
  deviceHeaders,
  harness,
} from "./devices-routes.test-fixtures.js";

function mintStub(): {
  vaultNames: Map<string, string>;
  live: Set<string>;
  mintCalls: () => number;
  mintVaultForPerson: (name: string) => { vaultId: string };
  unmintVaultForPerson: (vaultId: string) => void;
} {
  const vaultNames = new Map<string, string>([["vault-a", "Personal"]]);
  const live = new Set<string>();
  let minted = 0;
  return {
    vaultNames,
    live,
    mintCalls: () => minted,
    mintVaultForPerson: (name) => {
      minted += 1;
      const vaultId = `minted-vault-${minted}`;
      vaultNames.set(vaultId, name);
      live.add(vaultId);
      return { vaultId };
    },
    unmintVaultForPerson: (vaultId) => {
      live.delete(vaultId);
      vaultNames.delete(vaultId);
    },
  };
}

function rowCounts(f: DevicesHarness): {
  owners: number;
  vaultOwners: number;
  tickets: number;
  operations: number;
} {
  const count = (table: string): number =>
    (
      f.database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;
  return {
    owners: count("owners"),
    vaultOwners: count("vault_owners"),
    tickets: count("tickets"),
    operations: count("provision_operations"),
  };
}

async function mintForPerson(
  f: DevicesHarness,
  body: Record<string, unknown>,
  headers: Record<string, string> = deviceHeaders("founder-key")
): Promise<Response> {
  return fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("devices-routes mint-for-person scenarios (#726 P1)", () => {
  afterEach(cleanupHarnesses);

  test("add someone: redemption lands the new person's device in exactly their new vault", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
      unmintVaultForPerson: stub.unmintVaultForPerson,
    });
    const founder = f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
      ownerLabel: "Priya",
    });

    const response = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-add-kid-1",
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
    expect(payload.ownerId).not.toBe(founder.ownerId);
    expect(payload.ownerLabel).toBe("Kid");
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
    const response = await mintForPerson(f, {
      forPerson: { label: "Kid", vaultName: "Kid's Library" },
      operationId: "op-add-kid-2",
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
    const response = await mintForPerson(
      f,
      { forPerson: { label: "Guest" }, operationId: "op-add-guest" },
      { "content-type": "application/json" }
    );
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

    const combined = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      vaultIds: ["vault-a"],
      operationId: "op-combined",
    });
    expect(combined.status).toBe(400);
    await expect(combined.json()).resolves.toMatchObject({
      error: "invalid_body",
    });

    const malformed = await mintForPerson(f, {
      forPerson: { label: "" },
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: "invalid_for_person",
    });
  });
});

describe("mint-for-person is a durable provision (#750)", () => {
  afterEach(cleanupHarnesses);

  test("endpoint-capability preflight: no iroh endpoint refuses BEFORE creating anything", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
      unmintVaultForPerson: stub.unmintVaultForPerson,
      endpointTicket: () => undefined,
    });
    f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
    });
    const before = rowCounts(f);

    const response = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-endpointless",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "no_iroh_endpoint",
    });
    expect(rowCounts(f)).toStrictEqual(before);
    expect(stub.mintCalls()).toBe(0);
    expect(stub.live.size).toBe(0);
  });

  test("operationId is required for the forPerson lane and shape-checked", async () => {
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
    const before = rowCounts(f);

    const absent = await mintForPerson(f, { forPerson: { label: "Kid" } });
    expect(absent.status).toBe(400);
    await expect(absent.json()).resolves.toMatchObject({
      error: "operation_id_required",
    });

    const malformed = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "no spaces!",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: "invalid_operation_id",
    });

    expect(rowCounts(f)).toStrictEqual(before);
    expect(stub.mintCalls()).toBe(0);
  });

  test("failure BEFORE the durable steps (vault mint throws): zero debris, retry with the SAME operationId succeeds once", async () => {
    const stub = mintStub();
    let failNext = true;
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: (name) => {
        if (failNext) {
          failNext = false;
          throw new Error("disk full");
        }
        return stub.mintVaultForPerson(name);
      },
      unmintVaultForPerson: stub.unmintVaultForPerson,
    });
    f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
    });
    const before = rowCounts(f);

    const failed = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-retry-1",
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({
      error: "provision_failed",
    });
    expect(rowCounts(f)).toStrictEqual(before);
    expect(stub.live.size).toBe(0);

    const retried = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-retry-1",
    });
    expect(retried.status).toBe(200);
    expect(rowCounts(f)).toStrictEqual({
      owners: before.owners + 1,
      vaultOwners: before.vaultOwners + 1,
      tickets: before.tickets + 1,
      operations: before.operations + 1,
    });
    expect(stub.live.size).toBe(1);
  });

  test("failure AFTER the vault step (ticket insert throws): rollback + vault cleanup, retry with the SAME operationId succeeds once", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
      unmintVaultForPerson: stub.unmintVaultForPerson,
    });
    f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
    });
    const before = rowCounts(f);
    vi.spyOn(f.tickets, "mint").mockImplementationOnce(() => {
      throw new Error("ticket store exploded");
    });

    const failed = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-retry-2",
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({
      error: "provision_failed",
    });
    expect(rowCounts(f)).toStrictEqual(before);
    expect(stub.live.size).toBe(0);

    const retried = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-retry-2",
    });
    expect(retried.status).toBe(200);
    expect(rowCounts(f)).toStrictEqual({
      owners: before.owners + 1,
      vaultOwners: before.vaultOwners + 1,
      tickets: before.tickets + 1,
      operations: before.operations + 1,
    });
    expect(stub.mintCalls()).toBe(2);
    expect(stub.live.size).toBe(1);
  });

  test("replay after success returns the recorded result verbatim and creates nothing new", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
      unmintVaultForPerson: stub.unmintVaultForPerson,
    });
    f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
    });

    const first = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-replay",
    });
    expect(first.status).toBe(200);
    const original = (await first.json()) as Record<string, unknown>;
    const after = rowCounts(f);

    const replayed = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-replay",
    });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toStrictEqual(original);
    expect(rowCounts(f)).toStrictEqual(after);
    expect(stub.mintCalls()).toBe(1);
    expect(stub.live.size).toBe(1);
  });

  test("reusing an operationId with a DIFFERENT request is refused, not replayed", async () => {
    const stub = mintStub();
    const f = await harness({
      vaultName: (id) => stub.vaultNames.get(id),
      mintVaultForPerson: stub.mintVaultForPerson,
      unmintVaultForPerson: stub.unmintVaultForPerson,
    });
    f.enrollments.enroll({
      endpointId: "founder-key",
      vaultIds: ["vault-a"],
      label: "Founder laptop",
    });

    const first = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-conflict",
    });
    expect(first.status).toBe(200);
    const original = (await first.json()) as Record<string, unknown>;
    const after = rowCounts(f);

    const conflicting = await mintForPerson(f, {
      forPerson: { label: "Someone Else" },
      operationId: "op-conflict",
    });
    expect(conflicting.status).toBe(409);
    await expect(conflicting.json()).resolves.toMatchObject({
      error: "operation_id_conflict",
    });
    expect(rowCounts(f)).toStrictEqual(after);
    expect(stub.mintCalls()).toBe(1);

    const replayed = await mintForPerson(f, {
      forPerson: { label: "Kid" },
      operationId: "op-conflict",
    });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toStrictEqual(original);
    expect(rowCounts(f)).toStrictEqual(after);
  });
});
