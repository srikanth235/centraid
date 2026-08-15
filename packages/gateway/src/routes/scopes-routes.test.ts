import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, afterEach, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { makeScopesRouteHandler } from "./scopes-routes.js";
import type { ScopeVault } from "./scopes-routes.js";

/*
 * `GET /centraid/_vault/scopes` — the owner-scope registry read (#599 Phase 4,
 * ownership #726; #781 "sharing plane ownership"). Household's "Vaults you
 * own" block and every "which vault?" picker resolve from this one answer, and
 * the desktop e2e mock gateway mirrors it, so the real route's law is pinned
 * here: the caller's OWNED ∩ MOUNTED vaults in registry order, `canWrite`
 * sourced from ownership, a topology that never leaks by absence-not-refusal,
 * and `installed` answered only when an app was actually named.
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

/** Registry order: the default (personal) vault first, then oldest-first —
 *  including a vault the caller does NOT own, which must never appear. */
const MOUNTED: readonly ScopeVault[] = [
  { vaultId: "vault-a", name: "Personal", personal: true, color: "#5847e0" },
  { vaultId: "vault-b", name: "Sam's vault" },
  { vaultId: "vault-c", name: "Shared" },
];

interface Harness {
  base: string;
  enrollments: EnrollmentStore;
}

async function harness(
  mounted: readonly ScopeVault[] = MOUNTED
): Promise<Harness> {
  const dir = await tempDir("scopes-routes-");
  dirs.push(dir);
  const database = GatewayDatabase.open(dir);
  databases.push(database);
  const enrollments = EnrollmentStore.open(database);
  const handler = makeScopesRouteHandler({
    enrollments,
    listVaults: () => mounted,
    installedApps: (vaultId) =>
      vaultId === "vault-a" ? new Set(["notes"]) : new Set(),
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
  return { [AUTHED_DEVICE_HEADER]: endpointId };
}

/** Ada owns vault-a and vault-c; Sam owns vault-b. Ada is the caller. */
function household(f: Harness): void {
  f.enrollments.enroll({
    endpointId: "ep-ada",
    label: "Ada's MacBook",
    ownerLabel: "Ada",
    vaultIds: ["vault-a", "vault-c"],
  });
  f.enrollments.enroll({
    endpointId: "ep-sam",
    label: "Sam's laptop",
    ownerLabel: "Sam",
    vaultIds: ["vault-b"],
  });
}

describe("scopes-routes owner-scope registry", () => {
  afterEach(cleanup);

  test("listing without a proved owner-bound identity is refused", async () => {
    const f = await harness();
    household(f);
    const response = await fetch(`${f.base}/centraid/_vault/scopes`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "forbidden",
    });
  });

  test("a caller's scopes are their owned mounted vaults in registry order, and nobody else's appears", async () => {
    const f = await harness();
    household(f);
    const response = await fetch(`${f.base}/centraid/_vault/scopes`, {
      headers: deviceHeaders("ep-ada"),
    });
    expect(response.status).toBe(200);
    // The exact wire body Household and the pickers resolve from: ownership
    // is the visibility filter AND the source of `canWrite`; the `personal`
    // founding marker survives; Sam's vault-b is ABSENT — the listing leaks
    // no topology, so there is no "forbidden" row, only absence. No
    // `installed` key anywhere: no app was named, and "not asked" must stay
    // distinguishable from "not installed".
    await expect(response.json()).resolves.toStrictEqual({
      scopes: [
        {
          vaultId: "vault-a",
          label: "Personal",
          personal: true,
          color: "#5847e0",
          canWrite: true,
        },
        {
          vaultId: "vault-c",
          label: "Shared",
          personal: false,
          canWrite: true,
        },
      ],
    });
  });

  test("an owned vault the gateway no longer mounts is not a scope", async () => {
    // vault-c stays owned by Ada in gateway.db but is unmounted from the
    // registry: a place the caller cannot work must not be offered.
    const f = await harness(MOUNTED.filter((v) => v.vaultId !== "vault-c"));
    household(f);
    const response = await fetch(`${f.base}/centraid/_vault/scopes`, {
      headers: deviceHeaders("ep-ada"),
    });
    const body = (await response.json()) as {
      scopes: Array<{ vaultId: string }>;
    };
    expect(body.scopes.map((scope) => scope.vaultId)).toStrictEqual([
      "vault-a",
    ]);
  });

  test("`installed` is reported exactly when the request names an app", async () => {
    const f = await harness();
    household(f);
    const response = await fetch(`${f.base}/centraid/_vault/scopes?app=notes`, {
      headers: deviceHeaders("ep-ada"),
    });
    const body = (await response.json()) as {
      scopes: Array<{ vaultId: string; installed?: boolean }>;
    };
    expect(
      body.scopes.map((scope) => [scope.vaultId, scope.installed])
    ).toStrictEqual([
      ["vault-a", true],
      ["vault-c", false],
    ]);
  });

  test("host custody is above ownership: every mounted vault, in registry order", async () => {
    const f = await harness();
    household(f);
    const response = await fetch(`${f.base}/centraid/_vault/scopes`, {
      headers: { [HOST_CUSTODY_HEADER]: "1" },
    });
    const body = (await response.json()) as {
      scopes: Array<{ vaultId: string; canWrite: boolean }>;
    };
    expect(body.scopes.map((scope) => scope.vaultId)).toStrictEqual([
      "vault-a",
      "vault-b",
      "vault-c",
    ]);
    expect(body.scopes.every((scope) => scope.canWrite === true)).toBe(true);
  });

  test("the plane is read-only: writes answer 405, not a silent fallthrough", async () => {
    const f = await harness();
    household(f);
    const response = await fetch(`${f.base}/centraid/_vault/scopes`, {
      method: "POST",
      headers: deviceHeaders("ep-ada"),
    });
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toStrictEqual({
      error: "method_not_allowed",
    });
  });
});
