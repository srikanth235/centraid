import type { IncomingMessage } from 'node:http';
import type { EnrollmentStore, DeviceEnrollment } from '../serve/enrollment-store.js';
import { vaultContext } from '../serve/vault-context.js';
import { WEB_APP_HEADER } from '../serve/web-app-sessions.js';
import type { ReplicaShapeAccess } from './replica-shape.js';

export interface ReplicaRequestAccess extends ReplicaShapeAccess {
  deviceId: string;
  deviceKey?: string;
  enrollment?: DeviceEnrollment;
}

export type ReplicaAccessResolution =
  | { ok: true; access: ReplicaRequestAccess }
  | { ok: false; status: number; body: Record<string, unknown> };

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Resolve only host-authenticated ambient identity; no client device ids. */
export function resolveReplicaAccess(
  req: IncomingMessage,
  url: URL,
  vaultId: string,
  enrollments?: EnrollmentStore,
): ReplicaAccessResolution {
  const trustedApp = singleHeader(req.headers[WEB_APP_HEADER]);
  const selectedApp = url.searchParams.get('app') || undefined;
  if (trustedApp && selectedApp && trustedApp !== selectedApp) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'replica_app_scope_mismatch',
        message: 'the app session cannot select another app replica shape',
      },
    };
  }
  const appId = trustedApp ?? selectedApp;
  const deviceKey = vaultContext()?.deviceKey;
  if (deviceKey === undefined) {
    return {
      ok: true,
      access: {
        trust: 'full',
        rememberDevice: true,
        deviceId: `admin:${vaultId}`,
        ...(appId ? { appId } : {}),
      },
    };
  }
  const enrollment = enrollments?.get(deviceKey, vaultId);
  if (!enrollment || enrollment.trust === 'revoked') {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'replica_device_not_enrolled',
        message: 'the authenticated device is not enrolled for this vault',
      },
    };
  }
  return {
    ok: true,
    access: {
      trust: enrollment.trust,
      rememberDevice: enrollment.rememberDevice,
      deviceId: deviceKey,
      deviceKey,
      enrollment,
      ...(appId ? { appId } : {}),
    },
  };
}

export function expectedReplicaShapeIds(url: URL): string[] | undefined {
  const attested = url.searchParams.has('shapeId') || url.searchParams.has('shapeIds');
  const repeated = url.searchParams.getAll('shapeId').filter(Boolean);
  const packed = (url.searchParams.get('shapeIds') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const values = [...repeated, ...packed];
  return attested ? [...new Set(values)] : undefined;
}
