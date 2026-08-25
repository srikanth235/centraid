/*
 * Host-possession auth for the gateway's loopback control lane. The bearer is
 * HMAC(endpoint-key.bin, "centraid/landlord-http/v1") — stable for the
 * EndpointId lifetime, never persisted as an HTTP token. Rotating the key
 * rotates EndpointId; not a routine operation (SECURITY.md, #568 item J).
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
 * Bearer a daemon already serving `dataDir` derives when no parent pinned
 * `CENTRAID_GATEWAY_TOKEN`. Returns `undefined` when the endpoint identity is
 * unreadable. Never CREATES the key.
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
    // Unreadable custody is "cannot derive"; the caller spawns its own daemon.
    return undefined;
  }
}
