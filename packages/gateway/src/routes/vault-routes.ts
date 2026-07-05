/*
 * Owner-facing vault routes (duaility §12, phase P04) — the consent surface
 * over the mounted vault registry. Everything here is an OWNER act: the routes
 * run behind the gateway's host-level auth, and the planes execute them with
 * the owner-device credential. Apps never call these — their door is
 * `ctx.vault` inside handlers.
 *
 *   GET    /centraid/_vault/status                     — active vault presence + identity
 *   GET    /centraid/_vault/vaults                     — every vault, active flagged
 *   POST   /centraid/_vault/vaults                     — create {name?}
 *   PATCH  /centraid/_vault/vaults/<vaultId>           — update {name?, active?}
 *   DELETE /centraid/_vault/vaults/<vaultId>           — delete (409 while active)
 *   GET    /centraid/_vault/apps                       — enrolled apps + active grants
 *   POST   /centraid/_vault/apps/<appId>/grants        — approve {purpose, scopes[], expiresAt?}
 *   POST   /centraid/_vault/apps/<appId>/purge-ext     — drop a retained ext band (issue #286)
 *   GET    /centraid/_vault/agents                     — enrolled automation agents + grants
 *   POST   /centraid/_vault/agents/<appId>/grants      — approve an automation's agent grant
 *   DELETE /centraid/_vault/grants/<grantId>           — revoke (cascade runs)
 *   GET    /centraid/_vault/parked                     — invocations awaiting confirmation
 *   POST   /centraid/_vault/parked/<invocationId>      — {approve: boolean} → outcome
 *   GET    /centraid/_vault/picker?term=&kinds=&limit= — shell entity picker (issue #272)
 *   POST   /centraid/_vault/links                      — assert a link as the owner (pick-is-consent),
 *                                                        optionally carrying an inline anchor selector (issue #282)
 *   DELETE /centraid/_vault/links/<linkId>             — end a link (temporal, never deletes)
 *   PATCH  /centraid/_vault/links/<linkId>             — move/clear the link's standoff anchor {selector: {...}|null}
 *
 * Per-vault routes (everything below `vaults`) answer for the ACTIVE vault
 * unless `?vault=<vaultId>` names another one. Deny-by-default is structural:
 * until a POST …/grants lands, an enrolled app's every vault call is a
 * receipted deny — per vault.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { GrantRequest, VaultPlane } from '../serve/vault-plane.js';
import type { AnchorSelector } from '../serve/vault-picker.js';
import { VaultRegistryError, type VaultRegistry } from '../serve/vault-registry.js';
import { readJson, sendJson } from './route-helpers.js';

const PREFIX = '/centraid/_vault';

export function makeVaultRouteHandler(vaults: VaultRegistry): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeURIComponent);
    const method = req.method ?? 'GET';

    // Per-vault routes answer for the active vault unless ?vault= names one.
    const vaultParam = url.searchParams.get('vault');
    let plane: VaultPlane;
    try {
      plane = vaultParam === null ? vaults.active() : requirePlane(vaults, vaultParam);
    } catch (err) {
      return sendRegistryError(res, err);
    }

    try {
      if (method === 'GET' && (segments.length === 0 || segments[0] === 'status')) {
        return sendJson(res, 200, {
          active: true,
          vaultId: plane.boot.vaultId,
          name: plane.name,
          ownerPartyId: plane.boot.ownerPartyId,
          fresh: plane.boot.fresh,
        });
      }

      if (segments[0] === 'vaults') {
        return handleVaultsRoute(vaults, req, res, method, segments);
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

      // The explicit second half of uninstall (issue #286 phase 2):
      // uninstall RETAINS the app's ext band (the data is the owner's);
      // this drops its tables + registry rows for good.
      if (
        method === 'POST' &&
        segments[0] === 'apps' &&
        segments[2] === 'purge-ext' &&
        segments.length === 3
      ) {
        const appId = segments[1] ?? '';
        try {
          return sendJson(res, 200, plane.purgeAppExt(appId));
        } catch (err) {
          return sendJson(res, 400, {
            error: 'purge_failed',
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

      // The cross-referencing shell surface (issue #272): the picker is an
      // owner-trust search/browse, and link writes ride the owner-device
      // credential — the pick itself is the consent, scoped to one row.
      if (method === 'GET' && segments[0] === 'picker' && segments.length === 1) {
        const term = url.searchParams.get('term') ?? undefined;
        const kindsParam = url.searchParams.get('kinds');
        const kinds = kindsParam
          ? kindsParam
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean)
          : undefined;
        const limitParam = Number(url.searchParams.get('limit'));
        return sendJson(
          res,
          200,
          plane.pickEntities({
            ...(term !== undefined ? { term } : {}),
            ...(kinds ? { kinds } : {}),
            ...(Number.isFinite(limitParam) && limitParam > 0 ? { limit: limitParam } : {}),
          }),
        );
      }

      if (method === 'POST' && segments[0] === 'links' && segments.length === 1) {
        const body = await readJson(req);
        const fields = ['from_type', 'from_id', 'to_type', 'to_id'] as const;
        if (fields.some((f) => typeof body[f] !== 'string' || body[f] === '')) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'link body needs {from_type, from_id, to_type, to_id, relation?}',
          });
        }
        let selector: AnchorSelector | undefined;
        if (body.selector !== undefined) {
          selector = parseSelector(body.selector);
          if (selector === undefined) {
            return sendJson(res, 400, {
              error: 'bad_request',
              message: 'selector must be {exact, prefix, suffix, start}',
            });
          }
        }
        const outcome = plane.linkAsOwner({
          from_type: body.from_type as string,
          from_id: body.from_id as string,
          to_type: body.to_type as string,
          to_id: body.to_id as string,
          ...(typeof body.relation === 'string' && body.relation !== ''
            ? { relation: body.relation }
            : {}),
          ...(selector ? { selector } : {}),
        });
        return sendJson(res, 200, outcome);
      }

      if (method === 'DELETE' && segments[0] === 'links' && segments.length === 2) {
        return sendJson(res, 200, plane.unlinkAsOwner(segments[1] ?? ''));
      }

      // Re-anchor / re-baseline (issue #282): move the standoff anchor of a
      // live link ({selector: {...}}) or clear it ({selector: null}) —
      // demoting the reference to strip-only. A locator write; the link
      // judgment is untouched.
      if (method === 'PATCH' && segments[0] === 'links' && segments.length === 2) {
        const body = await readJson(req);
        if (!('selector' in body)) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'anchor body needs {selector: {exact, prefix, suffix, start} | null}',
          });
        }
        const selector = body.selector === null ? null : parseSelector(body.selector);
        if (selector === undefined) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'selector must be {exact, prefix, suffix, start} or null',
          });
        }
        return sendJson(res, 200, plane.anchorAsOwner(segments[1] ?? '', selector));
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

/** The vault-lifecycle sub-surface: list / create / update / delete. */
async function handleVaultsRoute(
  vaults: VaultRegistry,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
): Promise<boolean> {
  try {
    if (method === 'GET' && segments.length === 1) {
      return sendJson(res, 200, { vaults: vaults.list() });
    }

    if (method === 'POST' && segments.length === 1) {
      const body = await readJson(req);
      if (body.name !== undefined && typeof body.name !== 'string') {
        return sendJson(res, 400, { error: 'bad_request', message: 'name must be a string' });
      }
      return sendJson(res, 200, vaults.create(body.name as string | undefined));
    }

    if (method === 'PATCH' && segments.length === 2) {
      const vaultId = segments[1] ?? '';
      const body = await readJson(req);
      const presentationKeys = ['color', 'icon', 'blurb'] as const;
      const hasPresentation = presentationKeys.some((k) => body[k] !== undefined);
      if (body.name === undefined && body.active === undefined && !hasPresentation) {
        return sendJson(res, 400, {
          error: 'bad_request',
          message:
            'update body needs {name?: string, active?: true, color?: string, icon?: string, blurb?: string}',
        });
      }
      if (body.name !== undefined && typeof body.name !== 'string') {
        return sendJson(res, 400, { error: 'bad_request', message: 'name must be a string' });
      }
      for (const k of presentationKeys) {
        if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') {
          return sendJson(res, 400, { error: 'bad_request', message: `${k} must be a string` });
        }
      }
      if (body.active !== undefined && body.active !== true) {
        return sendJson(res, 400, {
          error: 'bad_request',
          message: 'active can only be set to true — activate another vault instead',
        });
      }
      let info = typeof body.name === 'string' ? vaults.rename(vaultId, body.name) : undefined;
      if (hasPresentation) {
        // Presentation lives IN the vault (#280: profiles are vaults) — the
        // switcher's color/icon/blurb travel with an export.
        const patch: Partial<Record<'color' | 'icon' | 'blurb', string | null>> = {};
        for (const k of presentationKeys) {
          if (body[k] !== undefined) patch[k] = body[k] as string | null;
        }
        info = vaults.updatePresentation(vaultId, patch);
      }
      if (body.active === true) {
        info = vaults.setActive(vaultId);
        // Re-root the gateway's workspace (#280: apps, transcripts, code all
        // follow the vault) BEFORE answering, so the renderer sees the new
        // world fully mounted when it reloads.
        await vaults.settleActivation();
      }
      return sendJson(res, 200, info ?? vaults.list().find((v) => v.vaultId === vaultId));
    }

    if (method === 'DELETE' && segments.length === 2) {
      vaults.delete(segments[1] ?? '');
      return sendJson(res, 200, { deleted: true });
    }

    return sendJson(res, 404, { error: 'not_found', message: 'unknown _vault/vaults route' });
  } catch (err) {
    return sendRegistryError(res, err);
  }
}

function requirePlane(vaults: VaultRegistry, vaultId: string): VaultPlane {
  const plane = vaults.get(vaultId);
  if (!plane) throw new VaultRegistryError('vault_not_found', `unknown vault "${vaultId}"`);
  return plane;
}

function sendRegistryError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof VaultRegistryError) {
    const status = err.code === 'vault_not_found' ? 404 : err.code === 'vault_active' ? 409 : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  return sendJson(res, 500, {
    error: 'internal_error',
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Validate a standoff-anchor selector from the wire (issue #282). Returns
 * undefined on anything malformed — the routes turn that into a 400.
 */
function parseSelector(raw: unknown): AnchorSelector | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.exact !== 'string' || s.exact.length === 0) return undefined;
  if (typeof s.prefix !== 'string' || typeof s.suffix !== 'string') return undefined;
  if (typeof s.start !== 'number' || !Number.isInteger(s.start) || s.start < 0) return undefined;
  return { exact: s.exact, prefix: s.prefix, suffix: s.suffix, start: s.start };
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
