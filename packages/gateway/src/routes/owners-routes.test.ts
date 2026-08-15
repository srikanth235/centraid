import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, afterEach, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { makeOwnersRouteHandler } from "./owners-routes.js";

/*
 * `GET/PATCH /centraid/_gateway/owners` — the Household roster's owner read
 * (#726; #781 "sharing plane ownership"). These are the reads the desktop
 * Household journey renders from and the e2e mock gateway mirrors, so the
 * real handler's visibility scoping is pinned here: a device caller sees its
 * OWN person only (topology hiding, re-aimed), host custody sees everyone,
 * and an invisible person is indistinguishable from an unknown one.
 */

const HOST_CUSTODY_HEADER = "x-test-host-custody";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

async function cleanup(): Promise<void> {
  for (const server of servers.splice(0)) server.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
}

interface Harness {
  base: string;
  enrollments: EnrollmentStore;
}

async function harness(): Promise<Harness> {
  const dir = await tempDir("owners-routes-");
  dirs.push(dir);
  const database = GatewayDatabase.open(dir);
  databases.push(database);
  const enrollments = EnrollmentStore.open(database);
  const handler = makeOwnersRouteHandler({
    enrollments,
    vaultName: (vaultId) =>
      vaultId === "vault-a"
        ? "Personal"
        : vaultId === "vault-b"
          ? "Sam's vault"
          : undefined,
    isHostCustody: (req) => req.headers[HOST_CUSTODY_HEADER] === "1",
  });
  const server = http.createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, enrollments };
}

function deviceHeaders(endpointId: string): Record<string, string> {
  return {
    [AUTHED_DEVICE_HEADER]: endpointId,
    "content-type": "application/json",
  };
}

/** Two people on one gateway: Ada (the caller) and Sam (her housemate). */
function household(f: Harness): { ada: string; sam: string } {
  const ada = f.enrollments.enroll({
    endpointId: "ep-ada",
    label: "Ada's MacBook",
    ownerLabel: "Ada",
    vaultIds: ["vault-a"],
  });
  const sam = f.enrollments.enroll({
    endpointId: "ep-sam",
    label: "Sam's laptop",
    ownerLabel: "Sam",
    vaultIds: ["vault-b"],
  });
  return { ada: ada.ownerId, sam: sam.ownerId };
}

describe("owners-routes roster scoping", () => {
  afterEach(cleanup);

  test("listing without a proved device identity is refused", async () => {
    const f = await harness();
    household(f);
    const response = await fetch(`${f.base}/centraid/_gateway/owners`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "device_identity_required",
    });
  });

  test("a device caller reads its own person only — the rest of the household is absent, not forbidden", async () => {
    const f = await harness();
    const { ada } = household(f);
    const response = await fetch(`${f.base}/centraid/_gateway/owners`, {
      headers: deviceHeaders("ep-ada"),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      owners: Array<Record<string, unknown>>;
    };
    // Exactly one row, and it is the whole DTO the Household roster renders:
    // the person, the vaults they own (resolved to names), and their live
    // hardware count. Sam does not appear at all — no forbidden row.
    expect(body.owners).toHaveLength(1);
    const owner = body.owners[0]!;
    expect({
      ownerId: owner.ownerId,
      label: owner.label,
      vaults: owner.vaults,
      deviceCount: owner.deviceCount,
    }).toStrictEqual({
      ownerId: ada,
      label: "Ada",
      vaults: [{ vaultId: "vault-a", vaultName: "Personal" }],
      deviceCount: 1,
    });
    expect(owner.createdAt).toBeTypeOf("string");
  });

  test("host custody reads every person on the gateway", async () => {
    const f = await harness();
    const { ada, sam } = household(f);
    const response = await fetch(`${f.base}/centraid/_gateway/owners`, {
      headers: { [HOST_CUSTODY_HEADER]: "1" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      owners: Array<{ ownerId: string; label: string }>;
    };
    const owners = body.owners
      .map((owner): [string, string] => [owner.ownerId, owner.label])
      .sort(([left], [right]) => left.localeCompare(right));
    const expected: Array<[string, string]> = [
      [ada, "Ada"],
      [sam, "Sam"],
    ];
    expect(owners).toStrictEqual(
      expected.sort(([left], [right]) => left.localeCompare(right))
    );
  });

  test("renaming keeps the owner id, so bindings and attribution survive", async () => {
    const f = await harness();
    const { ada } = household(f);
    const response = await fetch(
      `${f.base}/centraid/_gateway/owners/${encodeURIComponent(ada)}`,
      {
        method: "PATCH",
        headers: deviceHeaders("ep-ada"),
        body: JSON.stringify({ label: "Ada Lovelace" }),
      }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      owner: { ownerId: ada, label: "Ada Lovelace" },
    });
    // The rename is persisted where the roster reads it back.
    expect(f.enrollments.owners.get(ada)?.label).toBe("Ada Lovelace");
  });

  test("another person's id answers exactly like an unknown one — no existence leak", async () => {
    const f = await harness();
    const { sam } = household(f);
    const [housemate, unknown] = await Promise.all(
      [sam, "owner-does-not-exist"].map((ownerId) =>
        fetch(`${f.base}/centraid/_gateway/owners/${ownerId}`, {
          method: "PATCH",
          headers: deviceHeaders("ep-ada"),
          body: JSON.stringify({ label: "Hijacked" }),
        })
      )
    );
    expect(housemate!.status).toBe(404);
    expect(unknown!.status).toBe(404);
    // Byte-identical refusals: probing a real housemate's id must teach the
    // caller nothing an invented id would not.
    const bodies = await Promise.all([housemate!.json(), unknown!.json()]);
    expect(bodies[0]).toStrictEqual(bodies[1]);
    expect(f.enrollments.owners.get(sam)?.label).toBe("Sam");
  });
});
