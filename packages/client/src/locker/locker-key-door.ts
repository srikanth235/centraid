/*
 * FETCHING `K` (#996, ruling R13).
 *
 * One function, shared by every seat, because the answer to "how does this
 * device get the vault key" must not be three answers. A seat enrols, and
 * THEN — over the authenticated channel its enrolment opened — it asks the
 * key door for `K`. The pairing ticket never carries it: the ticket is a
 * base64url payload a camera reads off a screen, seen by whatever is pointed
 * at that screen and surviving in a photo roll, and it is validated before a
 * device exists to be the principal. Revoking a device would mean nothing
 * against a key that had already ridden a QR code.
 *
 * WHAT THE CALLER DOES WITH THE ANSWER IS THE BOUNDARY, AND IT IS NOT HERE.
 * This module hands back key bytes; storing them is per-seat and is the
 * subject of the unlock boundary (the phone's `requireAuthentication` store,
 * the desktop and PWA's PIN wrap). Nothing here writes to disk, and nothing
 * here caches — a module that quietly kept `K` in a module-level variable
 * would be a fourth copy of the key that no lock covers.
 */

import { ROUTES } from "@centraid/core/protocol";
import type { SeatLockerKeyWire } from "@centraid/core/protocol";

/** The vault key as a seat holds it: bytes, and which rotation they are. */
export interface LockerVaultKey {
  readonly vaultId: string;
  readonly keyId: string;
  readonly key: Uint8Array;
}

export interface LockerKeyDoorOptions {
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof globalThis.fetch;
}

/** The door refused, and why — a seat shows the reason rather than "failed". */
export class LockerKeyDoorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LockerKeyDoorError";
  }
}

function decodeBase64(value: string): Uint8Array {
  // `atob` in a browser, `Buffer` under node — the seat runs in both, and a
  // dependency for sixteen bytes of branching would be worse.
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Ask the gateway for `K`. The principal is the device row the request
 * authenticates as; there is nothing to send but the enrolment's own headers.
 */
export async function fetchLockerVaultKey(
  options: LockerKeyDoorOptions
): Promise<LockerVaultKey> {
  const call = options.fetch ?? globalThis.fetch.bind(globalThis);
  const url = new URL(ROUTES.vaultSeatLockerKey, options.baseUrl).toString();
  const response = await call(url, {
    headers: { ...options.headers, Accept: "application/json" },
    // A cached `K` is a copy of the key in a store nothing revokes.
    cache: "no-store",
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new LockerKeyDoorError(
      response.status,
      String(body["error"] ?? "seat_locker_key_refused"),
      String(
        body["message"] ??
          `the locker key door answered ${response.status} and gave no reason`
      )
    );
  }
  const answer = body as unknown as SeatLockerKeyWire;
  if (answer.algorithm !== "aes-256-gcm") {
    // A scheme this build does not know is a scheme it must not guess at:
    // decrypting under the wrong construction is silent, not loud.
    throw new LockerKeyDoorError(
      response.status,
      "seat_locker_key_algorithm",
      `this gateway seals Locker secrets with "${String(answer.algorithm)}", which this build does not implement — update the app`
    );
  }
  const key = decodeBase64(answer.key);
  if (key.byteLength !== 32) {
    throw new LockerKeyDoorError(
      response.status,
      "seat_locker_key_length",
      `the locker key door returned ${key.byteLength} bytes, expected 32`
    );
  }
  return { vaultId: answer.vaultId, keyId: answer.keyId, key };
}
