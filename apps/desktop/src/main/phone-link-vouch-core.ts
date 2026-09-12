/*
 * THE DESKTOP'S HALF OF PHONE ENROLMENT (#1015, ruling R-NY-18).
 *
 * Pairing a phone over QR used to touch the transport allowlist only. It now
 * also tells the local gateway that this EndpointId is one of the owner's
 * devices, and revoking the phone tells it the opposite — because a tunnelled
 * phone is its own principal at every vault door, so "revoke this phone" has
 * to reach the store those doors read.
 *
 * ELECTRON-FREE ON PURPOSE: this file is the testable core, so the rule about
 * what the call may carry can be pinned without booting a browser window.
 * `phone-link.ts` supplies the upstream and the gestures.
 *
 * THE CALL IS THE HOST'S OWN. It carries the loopback bearer and NOTHING
 * else — no forwarding stamp, no device header — because host custody is
 * precisely "a loopback request no forwarder touched", and a stamp on this
 * request would disqualify the gate that authorises it.
 */

import { PHONE_LINK_PATH } from "@centraid/tunnel";

export interface VouchUpstream {
  /** The local gateway's loopback base, e.g. `http://127.0.0.1:18789`. */
  readonly baseUrl: string;
  readonly token: string;
}

export interface VouchInput {
  readonly action: "enrol" | "revoke";
  readonly endpointId: string;
  readonly label?: string;
  readonly platform?: string;
}

export interface VouchResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
}

/**
 * Vouch for — or tombstone — one paired phone at the local gateway.
 *
 * NEVER THROWS. Pairing must not fail because the gateway was restarting, and
 * a revoke must still drop the transport allowlist row even if the enrolment
 * store could not be reached; the caller decides what to say about a refusal.
 * A remote gateway is active (or none is configured) when `upstream` is
 * undefined — the phone pairs with THIS desktop, not with remote gateways, so
 * there is nothing to vouch to and no call is made.
 */
export async function vouchPhoneDevice(
  upstream: VouchUpstream | undefined,
  input: VouchInput,
  doFetch: typeof globalThis.fetch = globalThis.fetch
): Promise<VouchResult> {
  if (!upstream) return { ok: false, error: "gateway_unavailable" };
  const body: Record<string, string> = {
    action: input.action,
    endpointId: input.endpointId,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  };
  try {
    const response = await doFetch(
      `${upstream.baseUrl.replace(/\/+$/u, "")}${PHONE_LINK_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${upstream.token}`,
        },
        body: JSON.stringify(body),
      }
    );
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
