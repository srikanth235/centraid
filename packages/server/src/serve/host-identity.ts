import { createHmac } from "node:crypto";

/**
 * The gateway host's own device identity, derived from the KeyStore-custodied
 * endpoint secret so it survives restarts without being stored twice. A
 * loopback-only gateway has no iroh pairing, so this is the EndpointId the
 * auto-founded personal vault (#603) is owned by; an explicit
 * `hostDeviceEndpointId` overrides it.
 */
export function kitlessHostIdentity(endpointSecret: Uint8Array): string {
  return `host:${createHmac("sha256", Buffer.from(endpointSecret))
    .update("centraid-kitless-host-v1")
    .digest("hex")}`;
}
