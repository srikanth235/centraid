import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, afterEach, expect, test, vi } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { PairingTicketStore } from "../serve/pairing-store.js";
import {
  hashControlToken,
  WebControlSessionStore,
} from "../serve/web-session-store.js";
import { makeDevicesRouteHandler } from "./devices-routes.js";
import { makeMembersRouteHandler } from "./members-routes.js";
import type { MembersRouteDeps } from "./members-routes.js";

/*
 * The household roster (issue #599 L2). These tests are about the two
 * removal VERBS staying distinct — "this phone was stolen" versus "this
 * person is out" — and about the id, not the label, being the key.
 */

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];
describe("members-routes suite", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  const VAULT_NAMES: Record<string, string> = {
    "vault-a": "Personal",
    "vault-b": "Family",
  };

  async function harness(): Promise<{
    members: string;
    devices: string;
    enrollments: EnrollmentStore;
    sessions: WebControlSessionStore;
    onEndpointRevoked: ReturnType<
      typeof vi.fn<NonNullable<MembersRouteDeps["onEndpointRevoked"]>>
    >;
  }> {
    const dir = await tempDir("members-routes-");
    dirs.push(dir);
    const database = GatewayDatabase.open(dir);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const sessions = WebControlSessionStore.open(database);
    const onEndpointRevoked =
      vi.fn<NonNullable<MembersRouteDeps["onEndpointRevoked"]>>();
    const vaultName = (vaultId: string): string | undefined =>
      VAULT_NAMES[vaultId];
    const membersHandler = makeMembersRouteHandler({
      enrollments,
      vaultName,
      onEndpointRevoked,
    });
    const devicesHandler = makeDevicesRouteHandler({
      enrollments,
      tickets: PairingTicketStore.open(database),
      vaultName,
      endpointTicket: () => "endpoint-ticket",
      onEndpointRevoked,
    });
    const server = http.createServer((req, res) => {
      void (async () => {
        if (await membersHandler(req, res)) return;
        await devicesHandler(req, res);
      })();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as AddressInfo;
    return {
      members: `http://127.0.0.1:${port}/centraid/_gateway/members`,
      devices: `http://127.0.0.1:${port}/centraid/_gateway/devices`,
      enrollments,
      sessions,
      onEndpointRevoked,
    };
  }

  function deviceHeaders(endpointId: string): Record<string, string> {
    return {
      [AUTHED_DEVICE_HEADER]: endpointId,
      "content-type": "application/json",
    };
  }

  /** Owner (admin of both vaults) + a `write` member with two devices. */
  function seed(enrollments: EnrollmentStore): {
    ownerId: string;
    sidId: string;
  } {
    const owner = enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      role: "admin",
      label: "Owner laptop",
      memberLabel: "Priya",
    });
    enrollments.members.setGrant(owner.memberId, "vault-b", "admin");
    const sid = enrollments.enroll({
      endpointId: "sid-phone",
      vaultId: "vault-b",
      role: "write",
      label: "Sid phone",
      memberLabel: "Sid",
    });
    enrollments.enroll({
      endpointId: "sid-tablet",
      label: "Sid tablet",
      memberId: sid.memberId,
    });
    return { ownerId: owner.memberId, sidId: sid.memberId };
  }

  test("the roster is people-first: members carry their roles and device counts", async () => {
    const f = await harness();
    const { ownerId, sidId } = seed(f.enrollments);

    expect((await fetch(f.members)).status).toBe(403);
    const response = await fetch(f.members, {
      headers: deviceHeaders("owner-key"),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      members: Array<{
        memberId: string;
        label: string;
        roles: unknown[];
        deviceCount: number;
      }>;
    };
    expect(body.members.map((member) => member.memberId)).toStrictEqual([
      ownerId,
      sidId,
    ]);
    expect(body.members[1]).toMatchObject({
      label: "Sid",
      deviceCount: 2,
      roles: [{ vaultId: "vault-b", vaultName: "Family", role: "write" }],
    });
  });

  test("renaming keeps the id, so every binding and grant follows the person", async () => {
    const f = await harness();
    const { sidId } = seed(f.enrollments);

    const renamed = await fetch(`${f.members}/${encodeURIComponent(sidId)}`, {
      method: "PATCH",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({ label: "Siddharth" }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      member: { memberId: sidId, label: "Siddharth" },
    });

    // Same id, same bindings, same authority — a rename is display only.
    const rows = f.enrollments.list().filter((row) => row.memberId === sidId);
    expect(
      [...new Set(rows.map((row) => row.endpointId))].sort()
    ).toStrictEqual(["sid-phone", "sid-tablet"]);
    expect(rows.every((row) => row.memberLabel === "Siddharth")).toBe(true);
    expect(f.enrollments.members.grants(sidId)).toStrictEqual([
      { vaultId: "vault-b", role: "write" },
    ]);
    expect(f.enrollments.vaultsFor("sid-tablet")).toStrictEqual(["vault-b"]);
  });

  test("revoke device leaves the person; remove member kills every binding at once", async () => {
    const f = await harness();
    const { sidId } = seed(f.enrollments);
    const phone = f.enrollments
      .list()
      .find((row) => row.endpointId === "sid-phone")!;
    const tokenHash = hashControlToken("sid-token");
    f.sessions.establish({
      tokenHash,
      vaultId: "vault-b",
      shellOrigin: "http://127.0.0.1:4173",
      deviceKey: "sid-phone",
    });

    // "This phone was stolen" — the member and their tablet are untouched.
    const revoked = await fetch(
      `${f.devices}/${encodeURIComponent(phone.enrollmentId)}`,
      {
        method: "DELETE",
        headers: deviceHeaders("owner-key"),
      }
    );
    expect(revoked.status).toBe(200);
    expect(f.enrollments.isEnrolled("sid-phone")).toBe(false);
    expect(f.enrollments.isEnrolled("sid-tablet")).toBe(true);
    expect(f.enrollments.members.get(sidId)).toBeDefined();
    expect(f.sessions.find(tokenHash)).toBeUndefined();

    // "This person is out" — one operation, not a loop over device rows.
    const removed = await fetch(`${f.members}/${encodeURIComponent(sidId)}`, {
      method: "DELETE",
      headers: deviceHeaders("owner-key"),
    });
    expect(removed.status).toBe(200);
    expect(f.enrollments.members.get(sidId)).toBeUndefined();
    expect(f.enrollments.isEnrolled("sid-tablet")).toBe(false);
    expect(f.enrollments.list().every((row) => row.memberId !== sidId)).toBe(
      true
    );
    expect(f.onEndpointRevoked).toHaveBeenCalledWith("sid-tablet");
  });

  test("removing the last admin member of a vault demands the vault name", async () => {
    const f = await harness();
    const { ownerId, sidId } = seed(f.enrollments);

    // A `write` member may not remove anyone.
    const refused = await fetch(`${f.members}/${encodeURIComponent(ownerId)}`, {
      method: "DELETE",
      headers: deviceHeaders("sid-phone"),
    });
    expect(refused.status).toBe(403);

    const url = `${f.members}/${encodeURIComponent(ownerId)}`;
    const missing = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders("owner-key"),
    });
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      error: "last_admin_confirmation_required",
    });

    const wrong = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({ confirmLastAdmin: "personal" }),
    });
    expect(wrong.status).toBe(409);

    const confirmed = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders("owner-key"),
      body: JSON.stringify({ confirmLastAdmin: "Personal" }),
    });
    expect(confirmed.status).toBe(200);
    expect(
      f.enrollments.members.list().map((member) => member.memberId)
    ).toStrictEqual([sidId]);
  });
});
