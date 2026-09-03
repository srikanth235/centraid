import type {
  EnrollmentStore,
  DeviceEnrollment,
} from "../serve/enrollment-store.js";
import { vaultContext } from "../serve/vault-context.js";
import type { ReplicaShapeAccess } from "./replica-shape.js";

export interface ReplicaRequestAccess extends ReplicaShapeAccess {
  deviceId: string;
  deviceKey?: string;
  ownerId?: string;
  enrollment?: DeviceEnrollment;
}

export type ReplicaAccessResolution =
  | { ok: true; access: ReplicaRequestAccess }
  | { ok: false; status: number; body: Record<string, unknown> };

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
