import type {
  EnrollmentStore,
  DeviceEnrollment,
} from "../serve/enrollment-store.js";
import { vaultContext } from "../serve/vault-context.js";
import type { ReplicaShapeAccess } from "./replica-shape.js";

export interface ReplicaRequestAccess extends ReplicaShapeAccess {
  deviceId: string;
  deviceKey?: string;
  /** The acting owner behind the device (#599 L2/L4, #726). */
  ownerId?: string;
  enrollment?: DeviceEnrollment;
}

export type ReplicaAccessResolution =
  | { ok: true; access: ReplicaRequestAccess }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Resolve only host-authenticated ambient identity; no client device ids.
 *
 * The `?app=` selector names which replica SHAPE the caller wants, nothing
 * more: the caller's authority is its device enrollment, which covers the
 * whole vault either way. There is no narrower per-app identity to contradict
 * the selector (#799).
 */
export function resolveReplicaAccess(
  url: URL,
  vaultId: string,
  enrollments?: EnrollmentStore
): ReplicaAccessResolution {
  const appId = url.searchParams.get("app") || undefined;
  const deviceKey = vaultContext()?.deviceKey;
  if (deviceKey === undefined) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "replica_device_identity_required",
        message: "replica access requires an authenticated enrolled device",
      },
    };
  }
  const enrollment = enrollments?.get(deviceKey, vaultId);
  if (!enrollment || enrollment.revoked) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "replica_device_not_enrolled",
        message: "the authenticated device is not enrolled for this vault",
      },
    };
  }
  return {
    ok: true,
    access: {
      // The derived enrollment view only yields vaults the device's owner
      // owns, so an un-revoked enrollment IS write authority (#726).
      canWrite: !enrollment.revoked,
      rememberDevice: enrollment.rememberDevice,
      deviceId: deviceKey,
      deviceKey,
      ownerId: enrollment.ownerId,
      enrollment,
      ...(appId ? { appId } : {}),
    },
  };
}

export function expectedReplicaShapeIds(url: URL): string[] | undefined {
  const attested =
    url.searchParams.has("shapeId") || url.searchParams.has("shapeIds");
  const repeated = url.searchParams.getAll("shapeId").filter(Boolean);
  const packed = (url.searchParams.get("shapeIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const values = [...repeated, ...packed];
  return attested ? [...new Set(values)] : undefined;
}
