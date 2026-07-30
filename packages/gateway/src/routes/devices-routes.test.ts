import { describe, afterEach, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import { hashControlToken } from "../serve/web-session-store.js";
import {
  cleanupHarnesses,
  deviceHeaders,
  harness,
} from "./devices-routes.test-fixtures.js";

describe("devices-routes scenarios", () => {
  afterEach(cleanupHarnesses);

  test("roster requires a proved identity and exposes only enrolled iroh rows", async () => {
    const f = await harness();
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      label: "Owner laptop",
      role: "admin",
    });
    f.enrollments.enroll({
      endpointId: "other-key",
      vaultId: "vault-b",
      label: "Other vault",
    });

    expect((await fetch(`${f.base}/centraid/_gateway/devices`)).status).toBe(
      403
    );
    const response = await fetch(`${f.base}/centraid/_gateway/devices`, {
      headers: deviceHeaders("owner-key"),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      devices: [
        {
          endpointId: "owner-key",
          transport: "iroh",
          vaultId: "vault-a",
          current: true,
          role: "admin",
        },
      ],
    });
  });

  test("revocation cascades web sessions and closes the iroh transport", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      label: "Owner",
      role: "admin",
    });
    const member = f.enrollments.enroll({
      endpointId: "member-key",
      vaultId: "vault-a",
      label: "Member",
      role: "write",
    });
    const tokenHash = hashControlToken("control-token");
    f.sessions.establish({
      tokenHash,
      vaultId: "vault-a",
      shellOrigin: "http://127.0.0.1:4173",
      deviceKey: "member-key",
    });
    expect(f.sessions.find(tokenHash)).toBeDefined();

    const response = await fetch(
      `${f.base}/centraid/_gateway/devices/${encodeURIComponent(member.enrollmentId)}`,
      {
        method: "DELETE",
        headers: deviceHeaders(owner.endpointId),
      }
    );
    expect(response.status).toBe(200);
    expect(f.enrollments.isEnrolled("member-key")).toBe(false);
    expect(f.sessions.find(tokenHash)).toBeUndefined();
    expect(f.onEndpointRevoked).toHaveBeenCalledWith("member-key");
  });

  test("revoking the last admin requires typing the vault name exactly", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      label: "Owner",
      role: "admin",
    });
    const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}`;

    const missing = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders(owner.endpointId),
    });
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      error: "last_admin_confirmation_required",
    });

    const wrong = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders(owner.endpointId),
      body: JSON.stringify({ confirmLastAdmin: "personal" }),
    });
    expect(wrong.status).toBe(409);

    const confirmed = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders(owner.endpointId),
      body: JSON.stringify({ confirmLastAdmin: "Personal" }),
    });
    expect(confirmed.status).toBe(200);
    // Revocation tombstones the BINDING; the owner member and their grant
    // survive so `devices add` from the box can bring a replacement device in.
    expect(
      f.enrollments.listByVault("vault-a").map((row) => row.role)
    ).toStrictEqual(["revoked"]);
    expect(f.enrollments.isEnrolled("owner-key")).toBe(false);
  });

  test("compute profile validates every capability and persists a valid update", async () => {
    const f = await harness();
    const device = f.enrollments.enroll({
      endpointId: "device-key",
      vaultId: "vault-a",
      label: "Phone",
      role: "write",
    });
    const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(device.enrollmentId)}/compute`;

    const invalid = await fetch(url, {
      method: "PUT",
      headers: deviceHeaders(device.endpointId),
      body: JSON.stringify({
        contributeWhileCharging: true,
        capabilities: { previews: true },
      }),
    });
    expect(invalid.status).toBe(400);

    const capabilities = {
      previews: true,
      poster: false,
      pdfText: true,
      ocr: false,
      embedding: true,
      transcript: false,
      edgeSeal: true,
      backgroundTransfer: false,
    };
    const updated = await fetch(url, {
      method: "PUT",
      headers: deviceHeaders(device.endpointId),
      body: JSON.stringify({ contributeWhileCharging: true, capabilities }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      device: { compute: { contributeWhileCharging: true, capabilities } },
    });
    expect(
      f.enrollments.get(device.endpointId, device.vaultId)?.compute
    ).toMatchObject({
      contributeWhileCharging: true,
      capabilities,
    });
  });

  /*
   * Branch coverage the #566 rewrite dropped (issue #568 item L).
   *
   * `devices-routes.test.ts` shrank from 18 tests to 5, leaving these live
   * branches unexercised: DELETE idempotency, the 405s, the foreign-vault 404,
   * peer-delete 403, self-unpair by a non-owner, `vault_required`, and the
   * no-endpoint 409. Each is a refusal or a
   * safe-default that would fail silently — every one returns a plausible-
   * looking status, so nothing downstream would notice a regression.
   */

  test("DELETE of an already-revoked enrollment is idempotent, not an error", async () => {
    const f = await harness();
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      label: "Owner",
      role: "admin",
    });
    const member = f.enrollments.enroll({
      endpointId: "member-key",
      vaultId: "vault-a",
      label: "Member",
      role: "write",
    });
    const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(member.enrollmentId)}`;

    const first = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders("owner-key"),
    });
    expect(first.status).toBe(200);
    // A client retrying after a dropped response must not see a 404 or a 500 —
    // the row is already gone and that IS the requested end state.
    const again = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders("owner-key"),
    });
    expect(again.status).toBe(200);
    expect(f.enrollments.isEnrolled("member-key")).toBe(false);
  });

  test("every devices route refuses a wrong method with 405", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      label: "Owner",
      role: "admin",
    });
    const cases: Array<[string, string]> = [
      ["/centraid/_gateway/devices", "POST"],
      ["/centraid/_gateway/devices/ticket", "GET"],
      [
        `/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}`,
        "PUT",
      ],
      [
        `/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}/compute`,
        "POST",
      ],
    ];
    await forEachSequentially(cases, async ([route, method]) => {
      const response = await fetch(`${f.base}${route}`, {
        method,
        headers: deviceHeaders("owner-key"),
      });
      expect(response.status, `${method} ${route}`).toBe(405);
      await expect(response.json()).resolves.toMatchObject({
        error: "method_not_allowed",
      });
    });
  });

  test("a device can rename itself and the roster reflects the label", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      label: "Old laptop",
      role: "admin",
    });
    const response = await fetch(
      `${f.base}/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}`,
      {
        method: "PATCH",
        headers: deviceHeaders("owner-key"),
        body: JSON.stringify({ label: "Work laptop" }),
      }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      device: { label: "Work laptop", current: true },
    });
    expect(
      f.enrollments
        .list()
        .find((row) => row.enrollmentId === owner.enrollmentId)?.label
    ).toBe("Work laptop");
  });

  test("an enrollment in a foreign vault 404s rather than leaking its existence", async () => {
    const f = await harness();
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      label: "Owner",
      role: "admin",
    });
    const foreign = f.enrollments.enroll({
      endpointId: "stranger-key",
      vaultId: "vault-b",
      label: "Stranger",
      role: "admin",
    });
    await forEachSequentially(
      [
        `/centraid/_gateway/devices/${encodeURIComponent(foreign.enrollmentId)}`,
        `/centraid/_gateway/devices/${encodeURIComponent(foreign.enrollmentId)}/compute`,
      ],
      async (route) => {
        const response = await fetch(`${f.base}${route}`, {
          method: route.endsWith("/compute") ? "PUT" : "DELETE",
          headers: deviceHeaders("owner-key"),
          ...(route.endsWith("/compute") ? { body: JSON.stringify({}) } : {}),
        });
        expect(response.status, route).toBe(404);
      }
    );
    expect(f.enrollments.isEnrolled("stranger-key")).toBe(true);
  });

  test("a full-role device cannot revoke a peer but may unpair itself", async () => {
    const f = await harness();
    f.enrollments.enroll({
      endpointId: "owner-key",
      vaultId: "vault-a",
      label: "Owner",
      role: "admin",
    });
    const member = f.enrollments.enroll({
      endpointId: "member-key",
      vaultId: "vault-a",
      label: "Member",
      role: "write",
    });
    const peer = f.enrollments.enroll({
      endpointId: "peer-key",
      vaultId: "vault-a",
      label: "Peer",
      role: "write",
    });

    // This is what stops a compromised `full` device from revoking its owner.
    const denied = await fetch(
      `${f.base}/centraid/_gateway/devices/${encodeURIComponent(peer.enrollmentId)}`,
      { method: "DELETE", headers: deviceHeaders("member-key") }
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: "not_admin" });
    expect(f.enrollments.isEnrolled("peer-key")).toBe(true);

    // Self-unpair by a non-owner stays allowed — leaving is always the device's
    // own call.
    const selfUnpair = await fetch(
      `${f.base}/centraid/_gateway/devices/${encodeURIComponent(member.enrollmentId)}`,
      { method: "DELETE", headers: deviceHeaders("member-key") }
    );
    expect(selfUnpair.status).toBe(200);
    expect(f.enrollments.isEnrolled("member-key")).toBe(false);
  });
});
