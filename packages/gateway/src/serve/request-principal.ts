import type { IncomingMessage } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";

import type { EnrollmentStore } from "./enrollment-store.js";

export interface RequestPrincipal {
  ownerId: string;
  deviceId: string;
}

/** Resolve authenticated owner/device context once at the route boundary. */
export function requestPrincipal(
  req: IncomingMessage,
  enrollments: EnrollmentStore
): RequestPrincipal | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const deviceId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof deviceId !== "string" || deviceId.length === 0) return undefined;
  const owner = enrollments.ownerFor(deviceId);
  return owner ? { ownerId: owner.ownerId, deviceId } : undefined;
}
