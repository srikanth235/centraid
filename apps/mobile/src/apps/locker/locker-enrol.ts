/*
 * ENROL THIS PHONE IN LOCKER (#1015, ruling R-NY-19).
 *
 * The one gesture that puts `K` on this device, and it lives in Locker rather
 * than in pairing. Pairing is a transport ceremony a member does once, in
 * Settings, often before they have opened Locker at all; the key to every
 * secret in the vault should not ride along with it unasked. So the member
 * asks for it on the Locker wall, where the thing they are unlocking is in
 * front of them, and the request goes over the channel their enrolment
 * already authenticated.
 *
 * WHY THE TUNNEL AND NOTHING ELSE. A manual gateway URL is the dev lane: the
 * phone holds a bearer in its own settings and talks to a LAN address. Over
 * that lane the request is not a proved device — and more to the point, the
 * key would arrive over a path whose other end the member never scanned.
 * `K` travels the tunnel or it does not travel.
 *
 * WHAT NEVER HAPPENS HERE. Nothing is logged from the answer — not the key,
 * not its id, not the body on a refusal. Nothing durable is written but the
 * keychain item itself, behind `requireAuthentication` and
 * `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`. The key bytes are zeroed once they
 * have been encoded, so the array the door allocated does not sit in this
 * app's heap waiting for a memory dump.
 */

import {
  fetchLockerVaultKey,
  LockerKeyDoorError,
} from "@centraid/client/locker";

import { storeLockerVaultKey } from "./locker-device-auth";
import {
  ENROL_NEEDS_TUNNEL,
  ENROL_NO_DOOR,
  ENROL_NOT_ALLOWED,
  ENROL_REFUSED,
  ENROL_WRONG_VAULT,
} from "./locker-seat-copy";

export type LockerEnrolFailure =
  | "no_tunnel"
  | "no_door"
  | "not_allowed"
  | "refused"
  | "wrong_vault";

export type LockerEnrolAnswer =
  | { readonly ok: true; readonly keyId: string }
  | {
      readonly ok: false;
      readonly reason: LockerEnrolFailure;
      readonly message: string;
    };

interface GatewayInfoAnswer {
  capabilities?: { seatLockerKey?: boolean };
}

export interface LockerEnrolDeps {
  /** `undefined` when this phone is unpaired or has no native tunnel. */
  readonly tunnel: () => Promise<{ baseUrl: string } | undefined>;
  readonly fetchKey: typeof fetchLockerVaultKey;
  readonly storeKey: typeof storeLockerVaultKey;
  readonly headers: () => Promise<Record<string, string>>;
  readonly doFetch: typeof globalThis.fetch;
}

const LIVE: LockerEnrolDeps = {
  // IMPORTED LAZILY, BOTH OF THEM. `lib/phone-link` drags the native tunnel
  // module in and `lib/gateway` drags `expo/fetch`; Locker's store is imported
  // by every Locker route, and a screen that never enrols should not pay for
  // either graph. It also keeps this module out of the import chain the Locker
  // suites already draw through the doors they mock.
  tunnel: async () => {
    const { ensureTunnelStarted } = await import("../../lib/phone-link");
    return ensureTunnelStarted();
  },
  fetchKey: fetchLockerVaultKey,
  storeKey: storeLockerVaultKey,
  headers: async () => {
    const { apiHeaders } = await import("../../lib/gateway");
    return apiHeaders();
  },
  doFetch: (input, init) => globalThis.fetch(input, init),
};

function refuse(
  reason: LockerEnrolFailure,
  message: string
): LockerEnrolAnswer {
  return { ok: false, reason, message };
}

/** Base64 without a Buffer copy that outlives the call. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

/**
 * Ask the gateway for this vault's Locker key and store it on this device.
 *
 * Idempotent from the member's point of view: enrolling a phone that is
 * already enrolled fetches the live key again and overwrites, which is also
 * how a phone catches up after a rotation.
 */
export async function enrolThisPhoneInLocker(
  vaultId: string,
  deps: Partial<LockerEnrolDeps> = {}
): Promise<LockerEnrolAnswer> {
  const { tunnel, fetchKey, storeKey, headers, doFetch } = { ...LIVE, ...deps };
  const link = await tunnel().catch(() => undefined);
  if (!link) return refuse("no_tunnel", ENROL_NEEDS_TUNNEL);

  // The flag, before the request: an older gateway has no door, and a 404 on
  // the key route cannot tell that apart from a route that refused.
  let capable = false;
  try {
    const response = await doFetch(
      new URL("/centraid/_gateway/info", link.baseUrl).toString(),
      { headers: await headers() }
    );
    if (response.ok) {
      const info = (await response.json()) as GatewayInfoAnswer;
      capable = info.capabilities?.seatLockerKey === true;
    }
  } catch {
    capable = false;
  }
  if (!capable) return refuse("no_door", ENROL_NO_DOOR);

  let answer;
  try {
    answer = await fetchKey({
      baseUrl: link.baseUrl,
      headers: await headers(),
    });
  } catch (error) {
    // A 403 is the one refusal with a repair the member can carry out: the
    // gateway does not recognise this phone as an enrolled device, which the
    // desktop's pairing gesture is what fixes. Everything else — a rotation
    // mid-flight, an algorithm this build does not implement, the radio — is
    // the same sentence and the same retry. Never the exception text (R-A-15).
    return error instanceof LockerKeyDoorError && error.status === 403
      ? refuse("not_allowed", ENROL_NOT_ALLOWED)
      : refuse("refused", ENROL_REFUSED);
  }
  if (answer.vaultId !== vaultId) {
    // The gateway answered for a different vault than the one this screen is
    // looking at. Storing it would leave this phone holding a key filed under
    // the wrong id — a reveal that fails much later, for no visible reason.
    answer.key.fill(0);
    return refuse("wrong_vault", ENROL_WRONG_VAULT);
  }
  const encoded = toBase64(answer.key);
  answer.key.fill(0);
  try {
    await storeKey(vaultId, { keyId: answer.keyId, key: encoded });
  } catch {
    return refuse("refused", ENROL_REFUSED);
  }
  return { ok: true, keyId: answer.keyId };
}
