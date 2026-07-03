/*
 * Owner-facing vault routes (duaility §12, phase P04) — the consent surface
 * over the mounted vault plane. Everything here is an OWNER act: the routes
 * run behind the gateway's host-level auth, and the plane executes them with
 * the owner-device credential. Apps never call these — their door is
 * `ctx.vault` inside handlers.
 *
 *   GET    /centraid/_vault/status                     — plane presence + identity
 *   GET    /centraid/_vault/apps                       — enrolled apps + active grants
 *   POST   /centraid/_vault/apps/<appId>/grants        — approve {purpose, scopes[], expiresAt?}
 *   GET    /centraid/_vault/agents                     — enrolled automation agents + grants
 *   POST   /centraid/_vault/agents/<appId>/grants      — approve an automation's agent grant
 *   DELETE /centraid/_vault/grants/<grantId>           — revoke (cascade runs)
 *   GET    /centraid/_vault/parked                     — invocations awaiting confirmation
 *   POST   /centraid/_vault/parked/<invocationId>      — {approve: boolean} → outcome
 *
 * Deny-by-default is structural: until a POST …/grants lands, an enrolled
 * app's every vault call is a receipted deny.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { GrantRequest, VaultPlane } from '../serve/vault-plane.js';
import { readJson, sendJson } from './route-helpers.js';

const PREFIX = '/centraid/_vault';

export function makeVaultRouteHandler(plane: VaultPlane): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeURIComponent);
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && (segments.length === 0 || segments[0] === 'status')) {
        return sendJson(res, 200, {
          active: true,
          vaultId: plane.boot.vaultId,
          ownerPartyId: plane.boot.ownerPartyId,
          fresh: plane.boot.fresh,
        });
      }

      if (method === 'GET' && segments[0] === 'apps' && segments.length === 1) {
        return sendJson(res, 200, { apps: plane.listApps() });
      }

      if (method === 'POST' && segments[0] === 'apps' && segments[2] === 'grants') {
        const appId = segments[1] ?? '';
        const body = await readJson(req);
        const request = parseGrantRequest(body);
        if (!request) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'grant body needs {purpose: string, scopes: [{schema, verbs, table?}]}',
          });
        }
        try {
          const grantId = plane.approveGrant(appId, request);
          return sendJson(res, 200, { grantId });
        } catch (err) {
          return sendJson(res, 400, {
            error: 'grant_refused',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (method === 'GET' && segments[0] === 'agents' && segments.length === 1) {
        return sendJson(res, 200, { agents: plane.listAgents() });
      }

      if (method === 'POST' && segments[0] === 'agents' && segments[2] === 'grants') {
        const appId = segments[1] ?? '';
        const body = await readJson(req);
        const request = parseGrantRequest(body);
        if (!request) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'grant body needs {purpose: string, scopes: [{schema, verbs, table?}]}',
          });
        }
        try {
          const grantId = plane.approveAgentGrant(appId, request);
          return sendJson(res, 200, { grantId });
        } catch (err) {
          return sendJson(res, 400, {
            error: 'grant_refused',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (method === 'DELETE' && segments[0] === 'grants' && segments.length === 2) {
        try {
          const result = plane.revokeGrant(segments[1] ?? '');
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 404, {
            error: 'revoke_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (method === 'GET' && segments[0] === 'parked' && segments.length === 1) {
        return sendJson(res, 200, { parked: plane.listParked() });
      }

      if (method === 'POST' && segments[0] === 'parked' && segments.length === 2) {
        const body = await readJson(req);
        if (typeof body.approve !== 'boolean') {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'confirmation body needs {approve: boolean}',
          });
        }
        try {
          const outcome = plane.confirmParked(segments[1] ?? '', body.approve);
          return sendJson(res, 200, outcome);
        } catch (err) {
          return sendJson(res, 404, {
            error: 'confirm_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return sendJson(res, 404, { error: 'not_found', message: 'unknown _vault route' });
    } catch (err) {
      return sendJson(res, 500, {
        error: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

const VERBS = new Set(['read', 'read+act', 'act']);

function parseGrantRequest(body: Record<string, unknown>): GrantRequest | undefined {
  if (typeof body.purpose !== 'string' || body.purpose.length === 0) return undefined;
  if (!Array.isArray(body.scopes) || body.scopes.length === 0) return undefined;
  const scopes: GrantRequest['scopes'] = [];
  for (const raw of body.scopes) {
    if (raw === null || typeof raw !== 'object') return undefined;
    const s = raw as Record<string, unknown>;
    if (typeof s.schema !== 'string' || s.schema.length === 0) return undefined;
    if (typeof s.verbs !== 'string' || !VERBS.has(s.verbs)) return undefined;
    if (s.table !== undefined && typeof s.table !== 'string') return undefined;
    scopes.push({
      schema: s.schema,
      verbs: s.verbs as 'read' | 'read+act' | 'act',
      ...(typeof s.table === 'string' ? { table: s.table } : {}),
    });
  }
  return {
    purpose: body.purpose,
    scopes,
    ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}),
  };
}
