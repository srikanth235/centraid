import { createHmac } from "node:crypto";

export function kitlessHostIdentity(endpointSecret: Uint8Array): string {
  return `host:${createHmac("sha256", Buffer.from(endpointSecret))
    .update("centraid-kitless-host-v1")
    .digest("hex")}`;
}
