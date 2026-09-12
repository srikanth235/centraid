/*
 * PAIRING A PHONE IS AN ENROLMENT, AND REVOKING ONE IS A TOMBSTONE
 * (#1015, ruling R-NY-18).
 *
 * QR pairing wrote `devices.json` and nothing else: the transport allowlist
 * knew the phone, and the vault's enrolment store had never heard of it. That
 * was survivable only while a tunnelled phone borrowed the host's identity —
 * which is the bug. Once the phone is its own principal, the pairing gesture
 * has to create the principal, and the revoke gesture has to tombstone it, or
 * "revoke this phone" would leave every vault door open to a device the
 * member believes they removed.
 */

import { describe, expect, test } from "vitest";

import { vouchPhoneDevice } from "./phone-link-vouch-core.js";

const UPSTREAM = { baseUrl: "http://127.0.0.1:18789", token: "host-bearer" };

function recorder(status = 200): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetch: typeof globalThis.fetch;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: status === 200 }), { status })
    );
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch: fetchImpl };
}

describe("the desktop vouches for the phone it just paired", () => {
  test("enrolling posts the phone's EndpointId under the host bearer", async () => {
    const { calls, fetch } = recorder();
    const answer = await vouchPhoneDevice(
      UPSTREAM,
      {
        action: "enrol",
        endpointId: "ep-phone",
        label: "Test iPhone",
        platform: "ios",
      },
      fetch
    );
    expect(answer.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "http://127.0.0.1:18789/centraid/_gateway/phone-link"
    );
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer host-bearer");
    // HOST CUSTODY: this is the desktop's own direct request. A forwarding
    // stamp on it would disqualify the very gate that authorises it.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      "x-centraid-device"
    );
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      "x-centraid-tunnel-forwarded"
    );
    expect(JSON.parse(String(call.init.body))).toStrictEqual({
      action: "enrol",
      endpointId: "ep-phone",
      label: "Test iPhone",
      platform: "ios",
    });
  });

  test("revoking posts the tombstone for the same EndpointId", async () => {
    const { calls, fetch } = recorder();
    const answer = await vouchPhoneDevice(
      UPSTREAM,
      { action: "revoke", endpointId: "ep-phone" },
      fetch
    );
    expect(answer.ok).toBe(true);
    expect(JSON.parse(String(calls[0]!.init.body))).toStrictEqual({
      action: "revoke",
      endpointId: "ep-phone",
    });
  });

  test("no local gateway means no call and a reported refusal, never a throw", async () => {
    const { calls, fetch } = recorder();
    const answer = await vouchPhoneDevice(
      undefined,
      { action: "revoke", endpointId: "ep-phone" },
      fetch
    );
    expect(answer).toStrictEqual({ ok: false, error: "gateway_unavailable" });
    expect(calls).toHaveLength(0);
  });

  test("a refusing gateway is reported rather than thrown", async () => {
    const { fetch } = recorder(403);
    const answer = await vouchPhoneDevice(
      UPSTREAM,
      { action: "enrol", endpointId: "ep-phone", label: "Phone" },
      fetch
    );
    expect(answer.ok).toBe(false);
    expect(answer.status).toBe(403);
  });

  test("an unreachable gateway is reported rather than thrown", async () => {
    const answer = await vouchPhoneDevice(
      UPSTREAM,
      { action: "revoke", endpointId: "ep-phone" },
      (() =>
        Promise.reject(
          new Error("ECONNREFUSED")
        )) as unknown as typeof globalThis.fetch
    );
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe("ECONNREFUSED");
  });
});
