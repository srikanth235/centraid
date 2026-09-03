import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, afterEach, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { VaultLinksStore } from "../serve/vault-links-store.js";
import { makeVaultLinksRouteHandler } from "./vault-links-routes.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

describe("vault-links-routes", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function setup(
    options: { vaultNames?: Record<string, string> } = {}
  ): Promise<{ base: string; database: GatewayDatabase }> {
    const dir = await tempDir("vault-links-routes-");
    dirs.push(dir);
    const database = GatewayDatabase.open(dir);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const store = new VaultLinksStore(database);
    enrollments.enroll({
      endpointId: "father-phone",
      vaultIds: ["vault-father"],
      label: "Father phone",
      ownerLabel: "Father",
    });
    enrollments.enroll({
      endpointId: "daughter-phone",
      vaultIds: ["vault-daughter"],
      label: "Daughter phone",
      ownerLabel: "Daughter",
    });
    const handler = makeVaultLinksRouteHandler({
      enrollments,
      store,
      gatewayDatabase: database,
      vaultPublicKey: (vaultId) =>
        vaultId.startsWith("vault-") ? `key-${vaultId}` : undefined,
      ownerPartyFor: (vaultId) =>
        vaultId.startsWith("vault-")
          ? `party-${vaultId.slice("vault-".length)}`
          : undefined,
      ...(options.vaultNames
        ? { vaultName: (vaultId: string) => options.vaultNames![vaultId] }
        : {}),
    });
    const server = http.createServer((req, res) => {
      void handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}/centraid/_gateway/links`,
      database,
    };
  }

  test("propose, list, and approve the full ceremony", async () => {
    const { base } = await setup();
    const proposed = await fetch(base, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "father-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-father",
        otherVaultId: "vault-daughter",
      }),
    });
    expect(proposed.status).toBe(201);
    const proposedBody = (await proposed.json()) as {
      link: {
        linkId: string;
        approved: boolean;
        partyIdA: string | null;
        partyIdB: string | null;
      };
    };
    expect(proposedBody.link.approved).toBe(false);
    expect(
      [proposedBody.link.partyIdA, proposedBody.link.partyIdB].toSorted(
        (a, b) => (a ?? "").localeCompare(b ?? "")
      )
    ).toStrictEqual(["party-daughter", "party-father"]);

    const fatherList = await fetch(base, {
      headers: { [AUTHED_DEVICE_HEADER]: "father-phone" },
    });
    await expect(fatherList.json()).resolves.toMatchObject({
      links: [expect.objectContaining({ linkId: proposedBody.link.linkId })],
    });

    const daughterList = await fetch(base, {
      headers: { [AUTHED_DEVICE_HEADER]: "daughter-phone" },
    });
    await expect(daughterList.json()).resolves.toMatchObject({
      links: [
        expect.objectContaining({
          linkId: proposedBody.link.linkId,
          approved: false,
        }),
      ],
    });

    const approved = await fetch(
      `${base}/${proposedBody.link.linkId}/approve`,
      {
        method: "POST",
        headers: { [AUTHED_DEVICE_HEADER]: "daughter-phone" },
      }
    );
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      link: { approved: true },
    });
  });

  test("proposing from a vault you do not own is refused not_found", async () => {
    const { base } = await setup();
    const response = await fetch(base, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "father-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-daughter",
        otherVaultId: "vault-father",
      }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  test("proposing to an unknown vault is refused not_found", async () => {
    const { base } = await setup();
    const response = await fetch(base, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "father-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-father",
        otherVaultId: "vault-nonexistent",
      }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  test("approving a link naming neither side you own is refused not_found (topology hiding)", async () => {
    const { base, database } = await setup();
    const enrollments = EnrollmentStore.open(database);
    enrollments.enroll({
      endpointId: "stranger-phone",
      vaultIds: ["vault-stranger"],
      label: "Stranger phone",
      ownerLabel: "Stranger",
    });
    const proposed = await fetch(base, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "father-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-father",
        otherVaultId: "vault-daughter",
      }),
    });
    const proposedBody = (await proposed.json()) as {
      link: { linkId: string };
    };
    const response = await fetch(
      `${base}/${proposedBody.link.linkId}/approve`,
      {
        method: "POST",
        headers: { [AUTHED_DEVICE_HEADER]: "stranger-phone" },
      }
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  test("a device with no proved identity is refused device_identity_required", async () => {
    const { base } = await setup();
    const response = await fetch(base);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "device_identity_required",
    });
  });

  test("a same-machine link is labeled with both vaults' own names (#726 P6 gap 3)", async () => {
    const { base } = await setup({
      vaultNames: {
        "vault-father": "Father's Vault",
        "vault-daughter": "Daughter's Vault",
      },
    });
    const proposed = await fetch(base, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "father-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-father",
        otherVaultId: "vault-daughter",
      }),
    });
    expect(proposed.status).toBe(201);
    const body = (await proposed.json()) as {
      link: { labelA: string | null; labelB: string | null };
    };
    expect([body.link.labelA, body.link.labelB]).toStrictEqual([
      "Daughter's Vault",
      "Father's Vault",
    ]);

    const listed = await fetch(base, {
      headers: { [AUTHED_DEVICE_HEADER]: "father-phone" },
    });
    const listedBody = (await listed.json()) as {
      links: Array<{ labelA: string | null; labelB: string | null }>;
    };
    expect([
      listedBody.links[0]!.labelA,
      listedBody.links[0]!.labelB,
    ]).toStrictEqual(["Daughter's Vault", "Father's Vault"]);
  });

  test("a link proposed with no name resolver stays honestly unlabeled, never a raw id", async () => {
    const { base } = await setup();
    const proposed = await fetch(base, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "father-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vaultId: "vault-father",
        otherVaultId: "vault-daughter",
      }),
    });
    const body = (await proposed.json()) as {
      link: { labelA: string | null; labelB: string | null };
    };
    expect(body.link.labelA).toBeNull();
    expect(body.link.labelB).toBeNull();
  });
});
