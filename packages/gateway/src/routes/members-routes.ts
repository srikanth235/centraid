/*
 * `/centraid/_gateway/members` — the household roster (issue #599 L2).
 *
 * Members are the principals authority is authored on; devices
 * (`devices-routes.ts`) are bindings that inherit. The two removal verbs live
 * on different routes on purpose:
 *
 *   DELETE /devices/:id   revoke a DEVICE — "this phone was stolen"; the
 *                         member and their other devices are untouched.
 *   DELETE /members/:id   remove a PERSON — one atomic operation that drops
 *                         their grants and every binding they own.
 *
 * Scope is the caller's own membership: a caller sees and touches only
 * members they share a vault with, and mutating another person requires
 * `admin` in every vault that person holds a role in. The host-custody lane
 * is L0 root and bypasses those checks.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';

import type { RouteHandler } from '../serve/build-gateway.js';
import type { DeviceEnrollment, EnrollmentStore } from '../serve/enrollment-store.js';
import type { Member } from '../serve/member-store.js';
import { readJson, sendJson } from './route-helpers.js';

const MEMBERS_PATH = '/centraid/_gateway/members';

export interface MembersRouteDeps {
  enrollments: EnrollmentStore;
  vaultName: (vaultId: string) => string | undefined;
  /** Direct host-custody request (authenticated bearer, never iroh-forwarded). */
  isHostCustody?: (req: IncomingMessage) => boolean;
  /** Purge vault-local protocol state owned by bindings this removal killed. */
  onRevoked?: (rows: DeviceEnrollment[]) => void | Promise<void>;
  /** Close Rust-owned live transports for every endpoint that lost its binding. */
  onEndpointRevoked?: (endpointId: string) => void | Promise<void>;
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function memberDto(deps: MembersRouteDeps, member: Member): Record<string, unknown> {
  const members = deps.enrollments.members;
  const devices = deps.enrollments.list().filter((row) => row.memberId === member.memberId);
  return {
    memberId: member.memberId,
    label: member.label,
    createdAt: member.createdAt,
    roles: members.grants(member.memberId).map((grant) => ({
      vaultId: grant.vaultId,
      vaultName: deps.vaultName(grant.vaultId),
      role: grant.role,
    })),
    deviceCount: new Set(devices.map((row) => row.endpointId)).size,
  };
}

export function makeMembersRouteHandler(deps: MembersRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== MEMBERS_PATH && !url.pathname.startsWith(`${MEMBERS_PATH}/`)) {
      return false;
    }
    const method = req.method ?? 'GET';
    const hostCustody = deps.isHostCustody?.(req) === true;
    const callerKey = callerDeviceKey(req);
    const caller = callerKey ? deps.enrollments.memberFor(callerKey) : undefined;
    if (!caller && !hostCustody) {
      return sendJson(res, 403, {
        error: 'device_identity_required',
        message: 'this route requires a proved iroh device identity',
      });
    }
    const members = deps.enrollments.members;
    const callerVaults = new Set(
      caller ? members.grants(caller.memberId).map((g) => g.vaultId) : [],
    );
    const visible = (member: Member): boolean =>
      hostCustody ||
      member.memberId === caller?.memberId ||
      members.grants(member.memberId).some((grant) => callerVaults.has(grant.vaultId));
    /** May the caller author this person's membership? */
    const mayAdminister = (member: Member): boolean => {
      if (hostCustody) return true;
      if (!caller) return false;
      const grants = members.grants(member.memberId);
      if (grants.length === 0)
        return members.grants(caller.memberId).some((g) => g.role === 'admin');
      return grants.every((grant) => members.roleIn(caller.memberId, grant.vaultId) === 'admin');
    };

    if (url.pathname === MEMBERS_PATH) {
      if (method === 'GET') {
        return sendJson(res, 200, {
          members: members
            .list()
            .filter(visible)
            .map((member) => memberDto(deps, member)),
        });
      }
      if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid_body' });
      }
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!label) return sendJson(res, 400, { error: 'label_required' });
      if (!hostCustody && !members.grants(caller?.memberId ?? '').some((g) => g.role === 'admin')) {
        return sendJson(res, 403, {
          error: 'not_admin',
          message: 'adding a person to the household is an ownership act',
        });
      }
      const created = members.create(label);
      return sendJson(res, 201, { member: memberDto(deps, created) });
    }

    const memberId = decodeURIComponent(url.pathname.slice(`${MEMBERS_PATH}/`.length));
    if (!memberId) return false;
    const member = members.get(memberId);
    // No existence leak: an invisible member and an unknown one 404 alike.
    if (!member || !visible(member)) return sendJson(res, 404, { error: 'not_found' });

    if (method === 'PATCH') {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid_body' });
      }
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!label) return sendJson(res, 400, { error: 'label_required' });
      // A person may always rename themselves; renaming someone else is an
      // ownership act. Either way the id is untouched, so every binding,
      // grant, and prior attribution survives the rename.
      if (member.memberId !== caller?.memberId && !mayAdminister(member)) {
        return sendJson(res, 403, { error: 'not_admin' });
      }
      return sendJson(res, 200, {
        member: memberDto(deps, members.rename(member.memberId, label)),
      });
    }

    if (method !== 'DELETE') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!mayAdminister(member)) {
      return sendJson(res, 403, {
        error: 'not_admin',
        message: 'removing a person requires admin in every vault they hold a role in',
      });
    }
    const orphaned = members.vaultsLosingLastAdmin(member.memberId);
    const firstOrphaned = orphaned[0];
    if (firstOrphaned !== undefined) {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const vaultName = deps.vaultName(firstOrphaned) ?? firstOrphaned;
      if (body.confirmLastAdmin !== vaultName) {
        return sendJson(res, 409, {
          error: 'last_admin_confirmation_required',
          message:
            `this is the last admin member of ${JSON.stringify(vaultName)}; type that name in ` +
            'confirmLastAdmin. Losing it requires filesystem access and the gateway CLI to recover.',
        });
      }
    }
    const removed = deps.enrollments.removeMember(member.memberId);
    await deps.onRevoked?.(removed);
    const deadEndpoints = new Set(removed.map((row) => row.endpointId));
    await Promise.all(
      [...deadEndpoints].map(async (endpointId) => {
        await deps.onEndpointRevoked?.(endpointId);
      }),
    );
    return sendJson(res, 200, {
      removed: true,
      memberId: member.memberId,
      devices: deadEndpoints.size,
    });
  };
}
