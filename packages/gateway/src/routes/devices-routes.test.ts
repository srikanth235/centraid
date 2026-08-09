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
      vaultIds: ["vault-a"],
      label: "Owner laptop",
    });
    f.enrollments.enroll({
      endpointId: "other-key",
      vaultIds: ["vault-b"],
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
          revoked: false,
        },
      ],
    });
  });

  test("revocation cascades web sessions and closes the iroh transport", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Owner",
    });
    const sibling = f.enrollments.enroll({
      endpointId: "sibling-key",
      vaultIds: ["vault-a"],
      label: "Second device",
      ownerId: owner.ownerId,
    });
    const tokenHash = hashControlToken("control-token");
    f.sessions.establish({
      tokenHash,
      vaultId: "vault-a",
      shellOrigin: "http://127.0.0.1:4173",
      deviceKey: "sibling-key",
    });
    expect(f.sessions.find(tokenHash)).toBeDefined();

    const response = await fetch(
      `${f.base}/centraid/_gateway/devices/${encodeURIComponent(sibling.enrollmentId)}`,
      {
        method: "DELETE",
        headers: deviceHeaders(owner.endpointId),
      }
    );
    expect(response.status).toBe(200);
    expect(f.enrollments.isEnrolled("sibling-key")).toBe(false);
    expect(f.sessions.find(tokenHash)).toBeUndefined();
    expect(f.onEndpointRevoked).toHaveBeenCalledWith("sibling-key");
  });

  test("revoking the owner's last device requires typing the vault name exactly", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Owner",
    });
    const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}`;

    const missing = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders(owner.endpointId),
    });
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      error: "last_device_confirmation_required",
    });

    const wrong = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders(owner.endpointId),
      body: JSON.stringify({ confirmLastDevice: "personal" }),
    });
    expect(wrong.status).toBe(409);

    const confirmed = await fetch(url, {
      method: "DELETE",
      headers: deviceHeaders(owner.endpointId),
      body: JSON.stringify({ confirmLastDevice: "Personal" }),
    });
    expect(confirmed.status).toBe(200);
    // Revocation tombstones the BINDING; the owner and their vault_owners
    // row survive so `devices add` from the box can bring a replacement in.
    expect(
      f.enrollments.listByVault("vault-a").map((row) => row.revoked)
    ).toStrictEqual([true]);
    expect(f.enrollments.isEnrolled("owner-key")).toBe(false);
    expect(f.enrollments.owners.ownerOf("vault-a")).toBe(owner.ownerId);
  });

  test("compute profile validates every capability and persists a valid update", async () => {
    const f = await harness();
    const device = f.enrollments.enroll({
      endpointId: "device-key",
      vaultIds: ["vault-a"],
      label: "Phone",
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
   * These live branches would otherwise go unexercised: DELETE idempotency,
   * the 405s, the foreign-vault 404, sibling revoke, `vault_required`, and
   * the no-endpoint 409. Each is a refusal or a safe-default that would fail
   * silently — every one returns a plausible-looking status, so nothing
   * downstream would notice a regression.
   */

  test("DELETE of an already-revoked enrollment is idempotent, not an error", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Owner",
    });
    const sibling = f.enrollments.enroll({
      endpointId: "sibling-key",
      vaultIds: ["vault-a"],
      label: "Second device",
      ownerId: owner.ownerId,
    });
    const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(sibling.enrollmentId)}`;

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
    expect(f.enrollments.isEnrolled("sibling-key")).toBe(false);
  });

  test("every devices route refuses a wrong method with 405", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Owner",
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
      vaultIds: ["vault-a"],
      label: "Old laptop",
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
      vaultIds: ["vault-a"],
      label: "Owner",
    });
    const foreign = f.enrollments.enroll({
      endpointId: "stranger-key",
      vaultIds: ["vault-b"],
      label: "Stranger",
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

  test("a sibling device may revoke another of its owner's devices", async () => {
    const f = await harness();
    const owner = f.enrollments.enroll({
      endpointId: "owner-key",
      vaultIds: ["vault-a"],
      label: "Laptop",
    });
    const phone = f.enrollments.enroll({
      endpointId: "phone-key",
      vaultIds: ["vault-a"],
      label: "Phone",
      ownerId: owner.ownerId,
    });

    // Every device a caller can see is its own owner's (one owner per vault,
    // #726), so revoking a sibling is the owner acting on their own gear —
    // the old role lattice's "not_admin" refusal has nothing left to refuse.
    const revoked = await fetch(
      `${f.base}/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}`,
      { method: "DELETE", headers: deviceHeaders("phone-key") }
    );
    expect(revoked.status).toBe(200);
    expect(f.enrollments.isEnrolled("owner-key")).toBe(false);

    // Self-unpair stays allowed — leaving is always the device's own call.
    // It is now the owner's last device, so the typed confirmation gates it.
    const selfUnpair = await fetch(
      `${f.base}/centraid/_gateway/devices/${encodeURIComponent(phone.enrollmentId)}`,
      {
        method: "DELETE",
        headers: deviceHeaders("phone-key"),
        body: JSON.stringify({ confirmLastDevice: "Personal" }),
      }
    );
    expect(selfUnpair.status).toBe(200);
    expect(f.enrollments.isEnrolled("phone-key")).toBe(false);
  });
});
