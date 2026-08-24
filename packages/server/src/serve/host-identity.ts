import { createHmac } from "node:crypto";

/**
 * The gateway host's own device identity, derived from the KeyStore-custodied
 * endpoint secret so it survives restarts without being stored twice.
 *
 * A gateway the owner runs on their own box answers over loopback with no
 * iroh pairing, so it still needs a device key to be enrolled under: this is
 * the EndpointId the auto-founded personal vault (#603) is owned by. A daemon
 * that receives an explicit `hostDeviceEndpointId` uses that instead.
 */
export function kitlessHostIdentity(endpointSecret: Uint8Array): string {
  return `host:${createHmac("sha256", Buffer.from(endpointSecret))
    .update("centraid-kitless-host-v1")
    .digest("hex")}`;
}
