/*
 * Host-possession authentication for the gateway's loopback control lane.
 *
 * The daemon never persists a reusable HTTP token. Instead, the loopback
 * bearer is DERIVED from the gateway endpoint secret, which is already under
 * KeyStore custody. A local process that can open that custody store can
 * derive the same bearer; a browser page, an enrolled remote peer, and a
 * copied desktop data directory cannot.
 *
 * The bearer is therefore STABLE for the life of the endpoint identity, not
 * per-boot: `HMAC(endpoint-key.bin, "centraid/landlord-http/v1")` yields the
 * same value on every start and is never rotated. Compromising
 * `endpoint-key.bin` yields lasting loopback HTTP admin, which is why that
 * key sits behind OS custody (`daemonKeyStore`) rather than a bare file.
 * Rotating it means rotating the gateway's permanent EndpointId, so it is
 * deliberately not a routine operation (see SECURITY.md, #568 item J).
 */

import { createHmac } from "node:crypto";

import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";

import { daemonKeyStore } from "./key-store.js";
import { daemonLayoutFor } from "./paths.js";

const LANDLORD_BEARER_CONTEXT = "centraid/landlord-http/v1";

export function landlordBearerForEndpointSecret(secret: Uint8Array): string {
  return createHmac("sha256", Buffer.from(secret))
    .update(LANDLORD_BEARER_CONTEXT, "utf8")
    .digest("hex");
}

/**
 * The bearer a daemon already serving `dataDir` derives when NO parent
 * pinned `CENTRAID_GATEWAY_TOKEN` — an OS-service install, for example.
 *
 * The desktop needs this to talk to a gateway it did not spawn: without it
 * the desktop probes with its own safeStorage-minted token, never matches,
 * and `decideControl` reports `'foreign'` forever after the user opts into
 * the OS service that onboarding offers (#568).
 *
 * Returns `undefined` when the endpoint identity is not readable — no keys
 * yet, or custody this process cannot open. Never CREATES the key: deriving
 * a bearer must not mint the gateway's permanent identity as a side effect.
 */
export function landlordBearerForDataDir(
  dataDir: string,
  options: { masterKey?: Buffer } = {}
): string | undefined {
  const keysDir = daemonLayoutFor(dataDir).keysDir;
  try {
    const store = options.masterKey
      ? new KeyStore(keysDir, {
          protector: aesGcmKeyProtector(options.masterKey),
        })
      : daemonKeyStore(keysDir);
    const secret = store.load("endpoint-key.bin");
    return secret ? landlordBearerForEndpointSecret(secret) : undefined;
  } catch {
    // Unreadable custody is a legitimate "cannot derive" answer here: the
    // caller falls back to spawning its own daemon. Surfacing it would turn
    // a first-run desktop with no keys yet into a hard failure.
    return undefined;
  }
}
