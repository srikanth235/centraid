// governance: allow-repo-hygiene file-size-limit the owner vault-consent surface is one route table — every handler shares the ambient-vault resolution + owner-device credential (#289)
/*
 * Owner-facing vault routes (duaility §12) — the consent surface over the
 * mounted vault registry. Everything here is an OWNER act: the routes run
 * behind the gateway's host-level auth, resolve the vault the REQUEST is
 * addressed to (issue #289 — the composed handler already established the
 * ambient vault scope from the `x-centraid-vault` header / device
 * enrollment), and the planes execute them with the owner-device
 * credential. Apps never call these — their door is `ctx.vault` inside
 * handlers.
 *
 *   GET    /centraid/_vault/status                     — the request vault's presence + identity
 *   GET    /centraid/_vault/vaults                     — vaults this caller may address
 *   PATCH  /centraid/_vault/vaults/<vaultId>           — update {name?, color?, icon?, blurb?}
 *   GET    /centraid/_vault/apps                       — enrolled apps + active grants
 *   POST   /centraid/_vault/apps/<appId>/grants        — approve {purpose, scopes[], expiresAt?}
 *   POST   /centraid/_vault/apps/<appId>/purge-ext     — drop a retained ext band (issue #286)
 *   GET    /centraid/_vault/agents                     — enrolled automation agents + grants
 *   POST   /centraid/_vault/agents/<appId>/grants      — approve an automation's agent grant
 *   DELETE /centraid/_vault/grants/<grantId>           — revoke (cascade runs)
 *   GET    /centraid/_vault/parked                     — invocations awaiting confirmation
 *   POST   /centraid/_vault/parked/<invocationId>      — {approve: boolean} → outcome
 *   GET    /centraid/_vault/outbox?status=             — external-write artifacts (issue #306), each carrying
 *                                                        `canEdit` (verb has a request rebuilder, outbox-edit.ts)
 *   POST   /centraid/_vault/outbox/<itemId>            — {decision, artifact?, always_allow?, note?} — an
 *                                                        edited `artifact` on an `approve` rebuilds the wire
 *                                                        request server-side (issue #308 A5 UI slice); a raw
 *                                                        `request` from the client is refused, not accepted
 *   GET    /centraid/_vault/outbox-grants              — standing (actor, verb, target) rules
 *   DELETE /centraid/_vault/outbox-grants/<grantId>    — revoke a standing rule
 *   GET    /centraid/_vault/blocking                   — things waiting on the owner (outbox + needs-auth + parked + scope requests)
 *   GET    /centraid/_vault/scope-requests             — open manifest scope-widening asks (issue #308)
 *   POST   /centraid/_vault/scope-requests/<requestId> — {approve: boolean} → decided request
 *   GET    /centraid/_vault/review?limit=              — salience-ranked receipt feed
 *   GET    /centraid/_vault/picker?term=&kinds=&limit= — shell entity picker (issue #272)
 *   POST   /centraid/_vault/links                      — assert a link as the owner (pick-is-consent),
 *                                                        optionally carrying an inline anchor selector (issue #282)
 *   DELETE /centraid/_vault/links/<linkId>             — end a link (temporal, never deletes)
 *   PATCH  /centraid/_vault/links/<linkId>             — move/clear the link's standoff anchor {selector: {...}|null}
 *
 * Vault create/delete left this surface (#289): they are ADMIN acts on the
 * gateway host (`centraid-gateway vault create|delete` over SSH). The vault
 * list is filtered to the calling device's enrollments — a family member
 * sees their vault and no evidence of others. Deny-by-default is
 * structural: until a POST …/grants lands, an enrolled app's every vault
 * call is a receipted deny — per vault.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { GrantRequest, OutboxItemSummary, VaultPlane } from '../serve/vault-plane.js';
import type { AnchorSelector } from '../serve/vault-picker.js';
import { VaultRegistryError, type VaultInfo, type VaultRegistry } from '../serve/vault-registry.js';
import { vaultContext, type DeviceAccess } from '../serve/vault-context.js';
import {
  assertArtifactShapeUnchanged,
  outboxVerbIsEditable,
  rebuilderForVerb,
  type OutboxWireRequest,
} from '../serve/outbox-edit.js';
import {
  atlasCensus,
  atlasGraph,
  atlasPulse,
  browseTableList,
  browseColumns,
  browseRows,
  browseRow,
  browseRefSearch,
  browseDependents,
  BrowseError,
  BROWSE_MAX_LIMIT,
  listVaultEntities,
  mediaLocationPolicy,
  readBlobStoreSettings,
  readEnrichSettings,
  s3TemporaryUploadPrefix,
  updateBlobStoreSettings,
  updateBackupPolicy,
  updateEnrichSettings,
  type EnrichTier,
} from '@centraid/vault';
import { readJson, sendJson } from './route-helpers.js';
import type { StorageConnectionStore } from '../backup/storage-connections.js';
import type { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { ensureProviderCasTarget } from '../backup/storage-credentials.js';
import { COMPANION_MODULES, companionModuleState } from './companion-grants.js';

const PREFIX = '/centraid/_vault';

export interface VaultRouteOptions {
  /**
   * Device-plane ACL (issue #289 phase 2). When set, the vault list is
   * filtered to the calling device's enrollments. Absent → the transport
   * is implicitly enrolled in every vault (loopback embed).
   */
  deviceAccess?: DeviceAccess;
  /**
   * Kick the outbox executor after an owner approval (issue #306) so the
   * drain happens now, not on the next periodic pass. Fire-and-forget.
   */
  onOutboxDecided?: (plane: VaultPlane) => void;
  /**
   * Resolve an automation app id to its real manifest display name, if one
   * is currently published (build-gateway.ts, backed by `automation.list()`
   * over the current vault's code). Threaded into the agent-grant approval
   * handler so a FIRST-touch enrollment (owner approves access before any
   * scheduler reconcile has run) still gets the automation's real name
   * instead of `ensureAgentEnrolled`'s bare `humanizeSlug(appId)` fallback.
   */
  resolveAutomationName?: (appId: string) => Promise<string | undefined> | string | undefined;
  /**
   * The gateway-level storage-connections entity (issue #367 §C1). When
   * set, `PUT /centraid/_vault/blob-store` resolves a `connectionId` in the
   * body against it — denormalizing endpoint/region/bucket/prefix and
   * `connectionKind` into the vault's `blob_store` settings, and forcing
   * `encrypt: true` for every remote CAS connection. Absent → the
   * legacy behavior (the caller supplies endpoint/bucket/region directly,
   * harness-ambient credentials).
   */
  storageConnections?: StorageConnectionStore;
  /**
   * Recovery-kit confirmation gate (issue #367 §C10): attaching a
   * `connectionId` to `blob_store` (enabling a CAS remote tier) is refused
   * with `409 recovery_kit_not_confirmed` unless either the operator has
   * confirmed the recovery kit, or the request carries `{force: true}`.
   */
  recoveryKit?: RecoveryKitStateStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Overlay `canEdit` on outbox rows for the owner surface (issue #308 A5 UI
 * slice) — whether the item's verb has a request rebuilder
 * (`outbox-edit.ts`). An overlay here, not a `vault-plane.ts` field, keeps
 * the plane free of an import on the gateway's verb registry.
 */
function withCanEdit(
  items: readonly OutboxItemSummary[],
): Array<OutboxItemSummary & { canEdit: boolean }> {
  return items.map((item) => ({ ...item, canEdit: outboxVerbIsEditable(item.verb) }));
}

export function makeVaultRouteHandler(
  vaults: VaultRegistry,
  options: VaultRouteOptions = {},
): RouteHandler {
  /** The vaults the calling device may see — all of them for keyless transports. */
  const visibleVaults = (): VaultInfo[] => {
    const deviceKey = vaultContext()?.deviceKey;
    if (deviceKey === undefined || !options.deviceAccess) return vaults.list();
    const enrolled = new Set(options.deviceAccess.vaultsFor(deviceKey));
    return vaults.list().filter((v) => enrolled.has(v.vaultId));
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeURIComponent);
    const method = req.method ?? 'GET';

    // Every per-vault route answers for the vault the request is addressed
    // to — resolved once by the composed handler, read here (#289).
    let plane: VaultPlane;
    try {
      plane = vaults.current();
    } catch (err) {
      return sendRegistryError(res, err);
    }

    try {
      if (method === 'GET' && (segments.length === 0 || segments[0] === 'status')) {
        return sendJson(res, 200, {
          vaultId: plane.boot.vaultId,
          name: plane.name,
          ownerPartyId: plane.boot.ownerPartyId,
          fresh: plane.boot.fresh,
        });
      }

      if (segments[0] === 'vaults') {
        return handleVaultsRoute(vaults, visibleVaults, req, res, method, segments);
      }

      // Byte-custody settings (issue #296, extended #367 §C1/§C4/§C10):
      // where the vault's blobs replicate (`blob_store`: fs | s3
      // endpoint/bucket/region/prefix/encrypt/connectionId — static creds
      // are never stored here; `connectionId` resolves through the
      // gateway-level `StorageConnectionStore`, the legacy harness-ambient
      // env-var lane still works without one) and the GPS extraction policy
      // (`media.location`: keep | strip).
      if (segments[0] === 'blob-store' && segments.length === 1) {
        if (method === 'GET') {
          const settings = readBlobStoreSettings(plane.db.vault);
          return sendJson(res, 200, {
            blob_store: {
              ...settings,
              ...(settings.kind === 's3' && settings.bucket
                ? {
                    allowedUploadPrefix: s3TemporaryUploadPrefix({
                      bucket: settings.bucket,
                      ...(settings.prefix ? { prefix: settings.prefix } : {}),
                    }),
                  }
                : {}),
            },
            media_location: mediaLocationPolicy(plane.db),
          });
        }
        if (method === 'PUT') {
          const priorBlobStore = readBlobStoreSettings(plane.db.vault);
          const body = await readJson(req);
          const blobStore = body.blob_store;
          const policyPatch: { storageClass?: string | null; throttleBytesPerSec?: number | null } =
            {};
          if (blobStore !== undefined && blobStore !== null) {
            if (typeof blobStore !== 'object' || Array.isArray(blobStore)) {
              return sendJson(res, 400, {
                error: 'bad_request',
                message: 'blob_store must be an object or null',
              });
            }
            const kind = (blobStore as Record<string, unknown>).kind;
            if (kind !== 'fs' && kind !== 's3') {
              return sendJson(res, 400, {
                error: 'bad_request',
                message: 'blob_store.kind must be "fs" or "s3"',
              });
            }
            // Storage class (issue #405 §6): an optional non-empty string,
            // trimmed and stored as `blob_store.storageClass` (camelCase,
            // matching throttleBytesPerSec). NO enum — S3-compatibles define
            // their own class names (STANDARD_IA, GLACIER, R2's single
            // implicit class, and clawgnition may grow `derived`/IA-style
            // tiers per clawgnition#118), so the endpoint, not this route, is
            // the authority on which names it accepts.
            const storageClass = (blobStore as Record<string, unknown>).storageClass;
            if (storageClass === null) {
              policyPatch.storageClass = null;
              delete (blobStore as Record<string, unknown>).storageClass;
            } else if (storageClass !== undefined) {
              if (typeof storageClass !== 'string' || storageClass.trim() === '') {
                return sendJson(res, 400, {
                  error: 'bad_request',
                  message: 'blob_store.storageClass must be a non-empty string',
                });
              }
              (blobStore as Record<string, unknown>).storageClass = storageClass.trim();
              policyPatch.storageClass = storageClass.trim();
              delete (blobStore as Record<string, unknown>).storageClass;
            }
            const throttle = (blobStore as Record<string, unknown>).throttleBytesPerSec;
            if (throttle === null) {
              policyPatch.throttleBytesPerSec = null;
              delete (blobStore as Record<string, unknown>).throttleBytesPerSec;
            } else if (throttle !== undefined) {
              if (typeof throttle !== 'number' || !Number.isFinite(throttle) || throttle <= 0) {
                return sendJson(res, 400, {
                  error: 'bad_request',
                  message: 'blob_store.throttleBytesPerSec must be a positive number',
                });
              }
              policyPatch.throttleBytesPerSec = throttle;
              delete (blobStore as Record<string, unknown>).throttleBytesPerSec;
            }
          }
          const mediaLocation = body.media_location;
          if (
            mediaLocation !== undefined &&
            mediaLocation !== null &&
            mediaLocation !== 'keep' &&
            mediaLocation !== 'strip'
          ) {
            return sendJson(res, 400, {
              error: 'bad_request',
              message: 'media_location must be "keep" or "strip"',
            });
          }

          // Attaching a storage connection (issue #367 §C1) — resolve
          // endpoint/region/bucket/prefix/connectionKind off the connection
          // row so the caller only ever names a `connectionId`, and gate on
          // the recovery-kit nudge before this vault starts replicating
          // off-box.
          let blobStorePatch = blobStore as Record<string, unknown> | null | undefined;
          let recoveryKitConfirmed: boolean | undefined;
          if (blobStorePatch?.['encrypt'] === false) {
            return sendJson(res, 400, {
              error: 'bad_request',
              message: 'remote CAS encryption cannot be disabled',
            });
          }
          const connectionId =
            blobStorePatch && typeof blobStorePatch['connectionId'] === 'string'
              ? (blobStorePatch['connectionId'] as string)
              : undefined;
          if (connectionId && options.storageConnections) {
            const connection = await options.storageConnections.get(connectionId);
            if (!connection) {
              return sendJson(res, 400, {
                error: 'bad_request',
                message: `unknown storage connection "${connectionId}"`,
              });
            }
            const status = await options.recoveryKit?.status();
            recoveryKitConfirmed =
              status?.confirmedAt !== null && status?.confirmedAt !== undefined;
            const force = body.force === true;
            if (options.recoveryKit && !recoveryKitConfirmed && !force) {
              return sendJson(res, 409, {
                error: 'recovery_kit_not_confirmed',
                recoveryKitConfirmed: false,
                message:
                  'confirm you have exported and safely stored the recovery kit before enabling ' +
                  'a remote storage tier (or resend with {force: true} to bypass)',
              });
            }
            // A provider connection's S3 coordinates aren't known until a
            // grant has been requested (PROTOCOL.md § Credential grant) —
            // `endpoint`/`bucket` never rotate per-grant for one target, so
            // this only round-trips once, at attach time.
            const target =
              connection.kind === 'provider' && !connection.endpoint && options.storageConnections
                ? await ensureProviderCasTarget(options.storageConnections, connectionId)
                : connection;
            blobStorePatch = {
              ...blobStorePatch,
              connectionId,
              connectionKind: connection.kind,
              encrypt: true,
              ...(target.endpoint ? { endpoint: target.endpoint } : {}),
              ...(target.region ? { region: target.region } : {}),
              ...(target.bucket ? { bucket: target.bucket } : {}),
              ...(target.prefix ? { prefix: target.prefix } : {}),
              // The `derived` store prefix (issue #425 Wave 2), present only when
              // the provider advertised + granted the store; absent ⇒ derivatives
              // stay on cas (graceful degradation).
              ...('derivedPrefix' in target && target.derivedPrefix
                ? { derivedPrefix: target.derivedPrefix }
                : {}),
              // Declared storage classes (issue #425 Wave 3): the vault's direct-to-cold heuristic engages only when STANDARD_IA is here.
              ...('supportedStorageClasses' in target && target.supportedStorageClasses
                ? { supportedStorageClasses: target.supportedStorageClasses }
                : {}),
            };
          }
          if (blobStorePatch?.['kind'] === 's3') {
            blobStorePatch = { ...blobStorePatch, encrypt: true };
          }

          const remoteIdentity = (value: Record<string, unknown>): string =>
            JSON.stringify(
              ['connectionId', 'endpoint', 'region', 'bucket', 'prefix', 'derivedPrefix'].map(
                (key) => value[key],
              ),
            );
          const attachingRemote =
            blobStorePatch?.['kind'] === 's3' &&
            (priorBlobStore.kind !== 's3' ||
              remoteIdentity(priorBlobStore as unknown as Record<string, unknown>) !==
                remoteIdentity(blobStorePatch));
          // Seed the outbox first: a crash before the settings write merely
          // leaves harmless obligations; a crash after it can never omit old
          // local bytes from remote-primary custody/snapshots.
          if (attachingRemote) {
            // Replica evidence is scoped to the old target even though the
            // table itself has no target column. Clear it before seeding new
            // obligations so every resident byte is copied to the new store.
            plane.db.blobTransfers.resetRemoteEvidence();
            plane.db.blobTransfers.enqueueExistingLocal();
          }
          updateBlobStoreSettings(plane.db, {
            ...(blobStorePatch !== undefined ? { blob_store: blobStorePatch } : {}),
            ...(mediaLocation !== undefined
              ? { media_location: mediaLocation as 'keep' | 'strip' | null }
              : {}),
          });
          if (Object.keys(policyPatch).length > 0) updateBackupPolicy(plane.db.vault, policyPatch);
          if (attachingRemote) plane.db.blobTransfers.kickOutbox();
          return sendJson(res, 200, {
            blob_store: readBlobStoreSettings(plane.db.vault),
            media_location: mediaLocationPolicy(plane.db),
            ...(recoveryKitConfirmed !== undefined ? { recoveryKitConfirmed } : {}),
          });
        }
      }

      // The owner's enrichment policy (issue #299 §2): Tier 0 (`local`) is
      // the default; `model` — derivative bytes leaving for an inference
      // provider — is a deliberate per-domain opt-in; `off` silences a
      // domain entirely.
      if (segments[0] === 'enrich' && segments.length === 1) {
        if (method === 'GET') {
          return sendJson(res, 200, { enrich: readEnrichSettings(plane.db) });
        }
        if (method === 'PUT') {
          const body = await readJson(req);
          const patch: Partial<Record<'photos' | 'docs', EnrichTier | null>> = {};
          for (const key of ['photos', 'docs'] as const) {
            const v = body[key];
            if (v === undefined) continue;
            if (v !== null && v !== 'off' && v !== 'local' && v !== 'model') {
              return sendJson(res, 400, {
                error: 'bad_request',
                message: `${key} must be "off", "local", "model" or null`,
              });
            }
            patch[key] = v as EnrichTier | null;
          }
          updateEnrichSettings(plane.db, patch);
          return sendJson(res, 200, { enrich: readEnrichSettings(plane.db) });
        }
      }

      if (method === 'GET' && segments[0] === 'apps' && segments.length === 1) {
        const companionProfile = vaultContext()?.grantProfile;
        if (companionProfile !== undefined) {
          const allowed = new Set(companionProfile);
          const apps = new Map(plane.listApps().map((app) => [app.name, app]));
          const modules = COMPANION_MODULES.map((id) => {
            const app = apps.get(id);
            return {
              id,
              state: companionModuleState(allowed, id, app),
            };
          });
          return sendJson(res, 200, { modules });
        }
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
          const displayName = await options.resolveAutomationName?.(appId);
          const grantId = plane.approveAgentGrant(appId, request, displayName);
          return sendJson(res, 200, { grantId });
        } catch (err) {
          return sendJson(res, 400, {
            error: 'grant_refused',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // The install/consent surface (issue #306 phase 4): declared-and-
      // granted scopes with salience highlights — what the install screen
      // and the app's consent card render.
      if (
        method === 'GET' &&
        segments[0] === 'apps' &&
        segments.length === 3 &&
        segments[2] === 'scopes'
      ) {
        return sendJson(res, 200, plane.scopeSurface(segments[1] ?? ''));
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

      // The outbox (issue #306): external writes as artifacts. GET lists the
      // items (pending first is the client's sort; the payload carries the
      // artifact itself); POST /<itemId> is the owner's decision — approve /
      // edit-then-approve / discard / always-allow — and an approval kicks
      // the executor so the send happens now, not on the next clock tick.
      if (method === 'GET' && segments[0] === 'outbox' && segments.length === 1) {
        const statusParam = url.searchParams.get('status');
        const statuses = statusParam
          ? statusParam
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        return sendJson(res, 200, { items: withCanEdit(plane.listOutbox(statuses)) });
      }

      if (method === 'POST' && segments[0] === 'outbox' && segments.length === 2) {
        const body = await readJson(req);
        if (body.decision !== 'approve' && body.decision !== 'discard') {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'outbox decision body needs {decision: "approve" | "discard"}',
          });
        }
        // The owner surface edits the ARTIFACT only — the wire request may
        // carry `{{connection:…}}` placeholders and connector plumbing it
        // never parses (see `listOutbox`'s doc comment). A raw `request`
        // from the client is refused outright rather than silently
        // ignored, so a caller is never left thinking an edit took effect
        // when it didn't.
        if (body.request !== undefined) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message:
              'the outbox route never accepts a raw "request" from the owner surface — edit the artifact and the gateway rebuilds the wire request server-side',
          });
        }
        const itemId = segments[1] ?? '';
        let rebuiltRequest: Record<string, unknown> | undefined;
        if (isRecord(body.artifact)) {
          // Edit-then-send is an approve-time act (issue #308 A5 UI
          // slice): discarding sends nothing, so there is nothing an
          // artifact edit could change about the outcome.
          if (body.decision !== 'approve') {
            return sendJson(res, 400, {
              error: 'bad_request',
              message:
                'an artifact edit only applies to "approve" — discarding sends nothing, so there is nothing to edit',
            });
          }
          const original = plane.rawOutboxItem(itemId);
          if (!original) {
            return sendJson(res, 404, {
              error: 'not_found',
              message: `no outbox item ${itemId}`,
            });
          }
          const rebuild = rebuilderForVerb(original.verb);
          if (!rebuild) {
            return sendJson(res, 400, {
              error: 'edit_unsupported',
              message: `editing isn't supported for ${original.verb} yet — approve or deny as staged`,
            });
          }
          try {
            assertArtifactShapeUnchanged(original.artifact, body.artifact);
            rebuiltRequest = rebuild(
              original.request as unknown as OutboxWireRequest,
              body.artifact,
            ) as unknown as Record<string, unknown>;
          } catch (err) {
            return sendJson(res, 400, {
              error: 'bad_request',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const outcome = await plane.decideOutbox({
          itemId,
          decision: body.decision,
          ...(isRecord(body.artifact) ? { artifact: body.artifact } : {}),
          ...(rebuiltRequest ? { request: rebuiltRequest } : {}),
          ...(typeof body.always_allow === 'boolean' ? { alwaysAllow: body.always_allow } : {}),
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
        });
        if (outcome.status === 'executed' && body.decision === 'approve') {
          options.onOutboxDecided?.(plane);
        }
        return sendJson(res, outcome.status === 'executed' ? 200 : 409, outcome);
      }

      if (method === 'GET' && segments[0] === 'outbox-grants' && segments.length === 1) {
        return sendJson(res, 200, { grants: plane.listOutboxGrants() });
      }

      if (method === 'DELETE' && segments[0] === 'outbox-grants' && segments.length === 2) {
        const outcome = await plane.revokeOutboxGrant(segments[1] ?? '');
        return sendJson(res, outcome.status === 'executed' ? 200 : 409, outcome);
      }

      // The honest split of the old parked surface (issue #306 decision 5):
      // BLOCKING = things waiting on the owner; REVIEW = what happened,
      // salience-ranked, with receipts.
      if (method === 'GET' && segments[0] === 'blocking' && segments.length === 1) {
        const blocking = plane.blocking();
        if (vaultContext()?.grantProfile !== undefined) {
          return sendJson(res, 200, {
            count:
              blocking.outbox.length +
              blocking.needsAuth.length +
              blocking.parked.length +
              blocking.scopeRequests.length,
          });
        }
        return sendJson(res, 200, { ...blocking, outbox: withCanEdit(blocking.outbox) });
      }

      // Manifest scope-widening requests (issue #308 A3): a published
      // manifest asking beyond its last consent parks here; the owner's
      // decision mints the grant (approve) or tombstones the ask (deny).
      if (method === 'GET' && segments[0] === 'scope-requests' && segments.length === 1) {
        return sendJson(res, 200, { requests: plane.listScopeRequests() });
      }

      if (method === 'POST' && segments[0] === 'scope-requests' && segments.length === 2) {
        const body = await readJson(req);
        if (typeof body.approve !== 'boolean') {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'scope-request decision body needs {approve: boolean}',
          });
        }
        try {
          const request = plane.decideScopeRequest(segments[1] ?? '', body.approve);
          return sendJson(res, 200, { request, approved: body.approve });
        } catch (err) {
          return sendJson(res, 404, {
            error: 'decide_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (method === 'GET' && segments[0] === 'review' && segments.length === 1) {
        const limitParam = Number(url.searchParams.get('limit'));
        return sendJson(res, 200, {
          entries: plane.reviewFeed(
            Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
          ),
        });
      }

      // The cross-referencing shell surface (issue #272): the picker is an
      // owner-trust search/browse, and link writes ride the owner-device
      // credential — the pick itself is the consent, scoped to one row.
      // Canonical domain entity types (`schema.table`) — the ontology model,
      // surfaced by the automation editor's @-tagging so the owner can reference
      // an entity kind ("@core.event") without a matching vault row to search.
      if (method === 'GET' && segments[0] === 'entities' && segments.length === 1) {
        return sendJson(res, 200, { entities: listVaultEntities() });
      }

      // The Vault Atlas (issue #441 Part B): three read-only owner census
      // surfaces over the registered ontology. All computed on request — an
      // owner ops screen, not a hot path. Numbers are derived from the live
      // schema (the FK walk, dbstat, the journal), never hardcoded.
      if (method === 'GET' && segments[0] === 'atlas' && segments.length === 2) {
        if (segments[1] === 'stats') {
          return sendJson(res, 200, atlasCensus(plane.db.vault, plane.db.journal));
        }
        if (segments[1] === 'graph') {
          // FK edges + per-edge fill + BFS rings, plus core_link aggregation
          // as a SEPARATE collection (FK ≠ core_link — the trap this must not
          // fall into). See atlas-census.ts.
          return sendJson(res, 200, atlasGraph(plane.db.vault));
        }
        if (segments[1] === 'pulse') {
          return sendJson(res, 200, atlasPulse(plane.db.journal));
        }
      }

      // The Vault Atlas Browse tab (issue #441 Part B, B3): a vault-aware
      // table editor. Reads are owner-trust census over the ontology; writes
      // ride the journalled command pipeline (atlas.* commands) with the
      // owner-device credential so every edit is a receipted operator act and
      // ships in the replica change log. All under `/atlas/browse/...`.
      if (segments[0] === 'atlas' && segments[1] === 'browse' && segments.length === 3) {
        const sub = segments[2];
        const table = url.searchParams.get('table') ?? '';
        try {
          if (method === 'GET' && sub === 'tables') {
            return sendJson(res, 200, { tables: browseTableList(plane.db.vault) });
          }
          if (method === 'GET' && sub === 'columns') {
            return sendJson(res, 200, browseColumns(plane.db.vault, table));
          }
          if (method === 'GET' && sub === 'rows') {
            const limitParam = Number(url.searchParams.get('limit'));
            const dirParam = url.searchParams.get('dir');
            return sendJson(
              res,
              200,
              browseRows(plane.db.vault, {
                table,
                ...(Number.isFinite(limitParam) && limitParam > 0
                  ? { limit: Math.min(limitParam, BROWSE_MAX_LIMIT) }
                  : {}),
                ...(url.searchParams.get('after') ? { after: url.searchParams.get('after')! } : {}),
                ...(url.searchParams.get('orderBy')
                  ? { orderBy: url.searchParams.get('orderBy')! }
                  : {}),
                ...(dirParam === 'desc' ? { dir: 'desc' as const } : {}),
              }),
            );
          }
          if (method === 'GET' && sub === 'row') {
            return sendJson(
              res,
              200,
              browseRow(plane.db.vault, table, url.searchParams.get('id') ?? ''),
            );
          }
          if (method === 'GET' && sub === 'ref-search') {
            return sendJson(res, 200, {
              hits: browseRefSearch(plane.db.vault, table, url.searchParams.get('query') ?? ''),
            });
          }
          if (method === 'GET' && sub === 'dependents') {
            return sendJson(
              res,
              200,
              browseDependents(plane.db.vault, table, url.searchParams.get('id') ?? ''),
            );
          }
        } catch (err) {
          if (err instanceof BrowseError) {
            const status = err.code === 'bad_request' ? 400 : 404;
            return sendJson(res, status, { error: err.code, message: err.message });
          }
          throw err;
        }

        if (method === 'POST' && sub === 'insert') {
          const body = await readJson(req);
          return runBrowseWrite(res, plane, 'atlas.insert_row', {
            table: body['table'],
            values: body['values'],
            ...(body['unlockMachinery'] === true ? { unlockMachinery: true } : {}),
          });
        }
        if (method === 'POST' && sub === 'update') {
          const body = await readJson(req);
          return runBrowseWrite(res, plane, 'atlas.update_row', {
            table: body['table'],
            id: body['id'],
            set: body['set'],
            ...(body['unlockMachinery'] === true ? { unlockMachinery: true } : {}),
          });
        }
        if (method === 'POST' && sub === 'delete') {
          const body = await readJson(req);
          const delTable = typeof body['table'] === 'string' ? body['table'] : '';
          const delId = typeof body['id'] === 'string' ? body['id'] : '';
          // Preflight the dependent walk so a blocked delete returns the FULL
          // dependent payload (engine + polymorphic) as a 409 — the command's
          // own guard only surfaces a reason string through the pipeline.
          try {
            const deps = browseDependents(plane.db.vault, delTable, delId);
            if (deps.hasEngineDependents) {
              return sendJson(res, 409, {
                error: 'has_dependents',
                message: `${deps.totalRows} row(s) reference this row`,
                dependents: deps.dependents,
                totalRows: deps.totalRows,
              });
            }
          } catch (err) {
            if (err instanceof BrowseError) {
              const status = err.code === 'bad_request' ? 400 : 404;
              return sendJson(res, status, { error: err.code, message: err.message });
            }
            throw err;
          }
          return runBrowseWrite(res, plane, 'atlas.delete_row', {
            table: body['table'],
            id: body['id'],
            ...(body['unlockMachinery'] === true ? { unlockMachinery: true } : {}),
          });
        }
      }

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
        const outcome = await plane.linkAsOwner({
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
        return sendJson(res, 200, await plane.unlinkAsOwner(segments[1] ?? ''));
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
        return sendJson(res, 200, await plane.anchorAsOwner(segments[1] ?? '', selector));
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

/**
 * The vault-list sub-surface: list the caller's vaults + owner updates
 * (rename / presentation). Create/delete are ADMIN acts on the gateway
 * host (#289) — a POST/DELETE here answers 405 so a stale client fails
 * loudly rather than silently.
 */
async function handleVaultsRoute(
  vaults: VaultRegistry,
  visibleVaults: () => VaultInfo[],
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
): Promise<boolean> {
  try {
    if (method === 'GET' && segments.length === 1) {
      return sendJson(res, 200, { vaults: visibleVaults() });
    }

    if (
      (method === 'POST' && segments.length === 1) ||
      (method === 'DELETE' && segments.length === 2)
    ) {
      return sendJson(res, 405, {
        error: 'admin_plane',
        message:
          'vault create/delete are admin acts — run `centraid-gateway vault …` on the gateway host',
      });
    }

    if (method === 'PATCH' && segments.length === 2) {
      const vaultId = segments[1] ?? '';
      // An owner act on ONE of the caller's vaults — a device may only
      // touch what it can see.
      if (!visibleVaults().some((v) => v.vaultId === vaultId)) {
        return sendJson(res, 404, {
          error: 'vault_not_found',
          message: `unknown vault "${vaultId}"`,
        });
      }
      const body = await readJson(req);
      const presentationKeys = ['color', 'icon', 'blurb'] as const;
      const hasPresentation = presentationKeys.some((k) => body[k] !== undefined);
      if (body.name === undefined && !hasPresentation) {
        return sendJson(res, 400, {
          error: 'bad_request',
          message:
            'update body needs {name?: string, color?: string, icon?: string, blurb?: string}',
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
      return sendJson(res, 200, info);
    }

    return sendJson(res, 404, { error: 'not_found', message: 'unknown _vault/vaults route' });
  } catch (err) {
    return sendRegistryError(res, err);
  }
}

/**
 * Run a Browse write (issue #441 B3) through the journalled command pipeline
 * with the owner-device credential, and shape the outcome: `executed` → 200
 * with the command output; `denied`/`failed` → 4xx with the reason (STRICT
 * NOT NULL / CHECK violations, sealed-column or machinery refusals all land
 * here as a clean error, never a crash).
 */
async function runBrowseWrite(
  res: ServerResponse,
  plane: VaultPlane,
  command: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const outcome = await plane.invoke(plane.ownerCredential, {
    command,
    input,
    purpose: 'dpv:ServiceProvision',
  });
  if (outcome.status === 'executed') {
    return sendJson(res, 200, { ok: true, ...(outcome.output as Record<string, unknown>) });
  }
  if (outcome.status === 'replayed') {
    return sendJson(res, 200, { ok: true, ...(outcome.output as Record<string, unknown>) });
  }
  // Everything else — denied / parked / failed — carries a reason.
  return sendJson(res, outcome.status === 'denied' ? 403 : 400, {
    ok: false,
    error: outcome.reason,
  });
}

function sendRegistryError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof VaultRegistryError) {
    const status = err.code === 'vault_not_found' ? 404 : err.code === 'vault_last' ? 409 : 400;
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

const VERBS = new Set(['read', 'read+act', 'act', 'reveal']);

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
      verbs: s.verbs as 'read' | 'read+act' | 'act' | 'reveal',
      ...(typeof s.table === 'string' ? { table: s.table } : {}),
    });
  }
  return {
    purpose: body.purpose,
    scopes,
    ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}),
  };
}
