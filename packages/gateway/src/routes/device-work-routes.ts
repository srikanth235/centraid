import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';
import {
  ENRICHMENT_CAPABILITIES,
  completeEnrichmentLease,
  enrichmentQueueDepth,
  leaseNextEnrichmentRequest,
  releaseEnrichmentLease,
  type EnrichmentCapability,
} from '@centraid/vault';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { EnrollmentStore } from '../serve/enrollment-store.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { readJson, sendJson } from './route-helpers.js';

const WORK_PATH = '/centraid/_gateway/device-work';

export interface DeviceWorkRouteDeps {
  vaults: VaultRegistry;
  enrollments: EnrollmentStore;
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requestedCapabilities(body: Record<string, unknown>): EnrichmentCapability[] {
  if (!Array.isArray(body.capabilities)) return [];
  const known = ENRICHMENT_CAPABILITIES as readonly string[];
  return [...new Set(body.capabilities)].filter(
    (value): value is EnrichmentCapability => typeof value === 'string' && known.includes(value),
  );
}

function vaultIdFrom(body: Record<string, unknown>): string | undefined {
  return typeof body.vaultId === 'string' && body.vaultId.length > 0 ? body.vaultId : undefined;
}

export function makeDeviceWorkRouteHandler(deps: DeviceWorkRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== WORK_PATH && !url.pathname.startsWith(`${WORK_PATH}/`)) return false;

    const method = req.method ?? 'GET';
    const callerKey = callerDeviceKey(req);
    const allowed = callerKey ? new Set(deps.enrollments.vaultsFor(callerKey)) : undefined;

    if (url.pathname === `${WORK_PATH}/status`) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      const vaults = deps.vaults
        .planesList()
        .filter((plane) => !allowed || allowed.has(plane.boot.vaultId))
        .map((plane) => ({
          vaultId: plane.boot.vaultId,
          name: plane.name,
          ...enrichmentQueueDepth(plane.db.vault),
        }));
      return sendJson(res, 200, { vaults });
    }

    if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!callerKey) {
      return sendJson(res, 403, {
        error: 'device_required',
        message: 'work leases require an authenticated paired device',
      });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid_body' });
    }
    const vaultId = vaultIdFrom(body);
    const plane = vaultId ? deps.vaults.get(vaultId) : undefined;
    const enrollment = vaultId ? deps.enrollments.get(callerKey, vaultId) : undefined;
    if (!vaultId || !plane || !enrollment) return sendJson(res, 404, { error: 'not_found' });

    if (url.pathname === `${WORK_PATH}/lease`) {
      if (
        !enrollment.compute?.contributeWhileCharging ||
        body.charging !== true ||
        body.unmetered !== true
      ) {
        return sendJson(res, 409, {
          error: 'device_not_eligible',
          message: 'work runs only after opt-in while charging and unmetered',
        });
      }
      const capabilities = requestedCapabilities(body).filter(
        (capability) => enrollment.compute?.capabilities[capability] === true,
      );
      const lease = leaseNextEnrichmentRequest(plane.db.vault, {
        deviceId: callerKey,
        capabilities,
        ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
      });
      return sendJson(res, 200, { lease });
    }

    const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
    const token = typeof body.token === 'string' ? body.token : undefined;
    if (!requestId || !token) return sendJson(res, 400, { error: 'invalid_lease' });
    if (url.pathname === `${WORK_PATH}/complete`) {
      const completed = completeEnrichmentLease(plane.db.vault, {
        requestId,
        deviceId: callerKey,
        token,
      });
      return sendJson(res, completed ? 200 : 409, { completed });
    }
    if (url.pathname === `${WORK_PATH}/release`) {
      const released = releaseEnrichmentLease(plane.db.vault, {
        requestId,
        deviceId: callerKey,
        token,
      });
      return sendJson(res, released ? 200 : 409, { released });
    }
    return false;
  };
}
