// governance: allow-repo-hygiene file-size-limit the owner vault-consent surface is one route table — every handler shares the ambient-vault resolution + owner-device credential (#289)
/*
 * Owner-facing vault routes (duality §12) under `/centraid/_vault` — the
 * consent surface over the mounted vault registry. Every handler is an OWNER
 * act: it runs behind the gateway's host-level auth, answers for the vault the
 * request is addressed to (resolved upstream from the `x-centraid-vault`
 * header / device enrollment, #289), and executes with the owner-device
 * credential. Apps never call these — their door is `ctx.vault`.
 *
 * Vault create/delete are ADMIN acts on the gateway host, not routes here
 * (#289). The vault list is filtered to the calling device's enrollments: an
 * owner sees no evidence of others' vaults. Deny-by-default is structural —
 * until a POST …/grants lands, an enrolled app's every vault call is a
 * receipted deny.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "@centraid/core/protocol";
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
} from "@centraid/vault";
import type { KeyStore, EnrichTier } from "@centraid/vault";

import type { RecoveryKitStateStore } from "../backup/recovery-kit-state.js";
import type { StorageConnectionStore } from "../backup/storage-connections.js";
import { ensureProviderCasTarget } from "../backup/storage-credentials.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { NotificationsEventBus } from "../serve/notifications-events.js";
import {
  assertArtifactShapeUnchanged,
  outboxVerbIsEditable,
  rebuilderForVerb,
} from "../serve/outbox-edit.js";
import type { OutboxWireRequest } from "../serve/outbox-edit.js";
import { vaultContext } from "../serve/vault-context.js";
import type { DeviceAccess } from "../serve/vault-context.js";
import type { AnchorSelector } from "../serve/vault-picker.js";
import type {
  GrantRequest,
  OutboxItemSummary,
  VaultPlane,
} from "../serve/vault-plane.js";
import { VaultRegistryError } from "../serve/vault-registry.js";
import type { VaultInfo, VaultRegistry } from "../serve/vault-registry.js";
import { COMPANION_MODULES, companionModuleState } from "./companion-grants.js";
import { readJson, sendJson, sendJsonConditional } from "./route-helpers.js";
import { SseSubscriberCap } from "./sse-cap.js";
import {
  enrichRulesFor,
  handleEnrichCascadeRoute,
} from "./vault-enrich-rules-routes.js";
import type { EnrichCapabilityCheck } from "./vault-enrich-rules-routes.js";

const PREFIX = "/centraid/_vault";
const defaultNotificationsSubscriberCap = new SseSubscriberCap();

export interface VaultRouteOptions {
  /** Device-plane ACL; route harnesses may omit it (#289). */
  deviceAccess?: DeviceAccess;
  /** Fire-and-forget: drains now, not on the next periodic pass. */
  onOutboxDecided?: (plane: VaultPlane) => void;
  /** The published manifest's display name, so a FIRST-touch enrollment does
   *  not fall back to `ensureAgentEnrolled`'s `humanizeSlug(appId)`. */
  resolveAutomationName?: (
    appId: string
  ) => Promise<string | undefined> | string | undefined;
  /** When set, a `connectionId` in a blob-store body resolves against it,
   *  denormalizing endpoint/region/bucket/prefix and forcing `encrypt: true`.
   *  Absent → the caller supplies endpoint/bucket/region directly (#367). */
  storageConnections?: StorageConnectionStore;
  /** Attaching a `connectionId` is refused `409 recovery_kit_not_confirmed`
   *  until the kit is exported, re-selected, and verified (#367). */
  recoveryKit?: RecoveryKitStateStore;
  enrollments?: EnrollmentStore;
  /** Host custody can SEE this vault, so it gets a typed `owner_only` refusal
   *  naming the owner — never `not_found` topology hiding (#726). */
  isHostCustody?: (req: IncomingMessage) => boolean;
  gatewayDatabase?: GatewayDatabase;
  keys?: KeyStore;
  /** Must land before an offsite-backed erase. */
  fenceVaultForErase?: (vaultId: string) => Promise<void>;
  /** Crash seam: after state commit, before file unlink. */
  afterEraseStateCommitted?: (vaultId: string) => void;
  notificationsEvents?: NotificationsEventBus;
  notificationsSubscriberCap?: SseSubscriberCap;
  /** Defaults to the bundled capability registry (#807). */
  enrichCapabilityKnown?: EnrichCapabilityCheck;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An overlay, not a plane field: the plane must not import the gateway's verb
 *  registry (#308). */
function withCanEdit(
  items: readonly OutboxItemSummary[]
): Array<OutboxItemSummary & { canEdit: boolean }> {
  return items.map((item) => ({
    ...item,
    canEdit: outboxVerbIsEditable(item.verb),
  }));
}

export function makeVaultRouteHandler(
  vaults: VaultRegistry,
  options: VaultRouteOptions = {}
): RouteHandler {
  const notificationsSubscriberCap =
    options.notificationsSubscriberCap ?? defaultNotificationsSubscriberCap;
  /** All vaults for keyless transports. */
  const visibleVaults = (): VaultInfo[] => {
    const deviceKey = vaultContext()?.deviceKey;
    if (deviceKey === undefined || !options.deviceAccess) return vaults.list();
    const enrolled = new Set(options.deviceAccess.vaultsFor(deviceKey));
    return vaults.list().filter((v) => enrolled.has(v.vaultId));
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`))
      return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//u, "");
    const segments = rest === "" ? [] : rest.split("/").map(decodeURIComponent);
    const method = req.method ?? "GET";

    let plane: VaultPlane;
    try {
      plane = vaults.current();
    } catch (error) {
      return sendRegistryError(res, error);
    }

    try {
      if (url.pathname === ROUTES.vaultErase) {
        if (method !== "POST") {
          return sendJson(res, 405, {
            error: "method_not_allowed",
            message: "POST only",
          });
        }
        const deviceKey = vaultContext()?.deviceKey;
        const enrollment =
          deviceKey && options.enrollments
            ? options.enrollments.get(deviceKey, plane.boot.vaultId)
            : undefined;
        if (!enrollment || enrollment.revoked) {
          if (options.isHostCustody?.(req) === true) {
            const ownerId = options.enrollments?.owners.ownerOf(
              plane.boot.vaultId
            );
            const ownerLabel = ownerId
              ? options.enrollments?.owners.get(ownerId)?.label
              : undefined;
            return sendJson(res, 403, {
              error: "owner_only",
              message: `only ${ownerLabel ?? "this vault's owner"} can erase this vault`,
            });
          }
          return sendJson(res, 403, {
            error: "owner_required",
            message: "only the vault owner's device can erase this vault",
          });
        }
        if (!options.gatewayDatabase || !options.keys || !options.recoveryKit) {
          return sendJson(res, 503, {
            error: "erase_unavailable",
            message: "this gateway host has no erase custody wiring",
          });
        }
        const body = await readJson(req);
        if (body.name !== plane.name) {
          return sendJson(res, 409, {
            error: "typed_name_required",
            message: `type the vault name exactly (${JSON.stringify(plane.name)}) to erase it`,
          });
        }
        const kit = await options.recoveryKit.status();
        if (kit.confirmedAt === null) {
          return sendJson(res, 409, {
            error: "recovery_kit_not_verified",
            message:
              "verify and retain the recovery kit before erasing this vault",
          });
        }
        const vaultId = plane.boot.vaultId;
        await options.fenceVaultForErase?.(vaultId);
        options.gatewayDatabase.transaction(() => {
          options
            .gatewayDatabase!.db.prepare(
              `INSERT INTO erase_intents (vault_id, created_at) VALUES (?, ?)
               ON CONFLICT(vault_id) DO NOTHING`
            )
            .run(vaultId, new Date().toISOString());
          // The `vault_owners` row is the whole authority record (#726).
          // Web sessions and replica checkpoints are vault-keyed, so they go
          // explicitly.
          options
            .gatewayDatabase!.db.prepare(
              "DELETE FROM vault_owners WHERE vault_id = ?"
            )
            .run(vaultId);
          options
            .gatewayDatabase!.db.prepare(
              "DELETE FROM device_checkpoints WHERE vault_id = ?"
            )
            .run(vaultId);
          options
            .gatewayDatabase!.db.prepare(
              "DELETE FROM web_sessions WHERE vault_id = ?"
            )
            .run(vaultId);
          options
            .gatewayDatabase!.db.prepare(
              `DELETE FROM tickets
                WHERE EXISTS (
                  SELECT 1 FROM json_each(tickets.grants_json)
                   WHERE json_each.value = ?
                )`
            )
            .run(vaultId);
          options
            .gatewayDatabase!.db.prepare(
              "DELETE FROM backup_targets WHERE vault_id = ?"
            )
            .run(vaultId);
          options
            .gatewayDatabase!.db.prepare(
              "DELETE FROM cas_reconciliations WHERE vault_id = ?"
            )
            .run(vaultId);
        });
        options.afterEraseStateCommitted?.(vaultId);
        vaults.delete(vaultId);
        options.keys.destroy(`${vaultId}.sealkey`);
        // The identity keypair shares the DEK's custody (#726) and the
        // public-key PIN goes with it (#750 invariant 1): a pin outliving its
        // seed is what `VaultIdentityMismatchError` refuses to open, so a
        // leftover makes a re-created vault of the same id unopenable.
        options.keys.destroy(`${vaultId}.identity`);
        options.keys.destroy(`${vaultId}.identity.pub`);
        options.gatewayDatabase.transaction(() => {
          options
            .gatewayDatabase!.db.prepare(
              "DELETE FROM erase_intents WHERE vault_id = ?"
            )
            .run(vaultId);
        });
        return sendJson(res, 200, {
          ok: true,
          erasedVaultId: vaultId,
          remainingVaults: vaults.list().length,
        });
      }

      if (
        method === "GET" &&
        (segments.length === 0 || segments[0] === "status")
      ) {
        return sendJson(res, 200, {
          vaultId: plane.boot.vaultId,
          name: plane.name,
          ownerPartyId: plane.boot.ownerPartyId,
          fresh: plane.boot.fresh,
        });
      }

      if (segments[0] === "vaults") {
        return handleVaultsRoute(
          vaults,
          visibleVaults,
          options,
          req,
          res,
          method,
          segments
        );
      }

      // Static credentials are NEVER stored here — a `connectionId` resolves
      // through the gateway-level `StorageConnectionStore` (#296, #367).
      if (segments[0] === "blob-store" && segments.length === 1) {
        if (method === "GET") {
          const settings = readBlobStoreSettings(plane.db.vault);
          return sendJson(res, 200, {
            blob_store: {
              ...settings,
              ...(settings.kind === "s3" && settings.bucket
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
        if (method === "PUT") {
          const priorBlobStore = readBlobStoreSettings(plane.db.vault);
          const body = await readJson(req);
          const blobStore = body.blob_store;
          const policyPatch: {
            storageClass?: string | null;
            throttleBytesPerSec?: number | null;
          } = {};
          if (blobStore !== undefined && blobStore !== null) {
            if (typeof blobStore !== "object" || Array.isArray(blobStore)) {
              return sendJson(res, 400, {
                error: "bad_request",
                message: "blob_store must be an object or null",
              });
            }
            const kind = (blobStore as Record<string, unknown>).kind;
            if (kind !== "fs" && kind !== "s3") {
              return sendJson(res, 400, {
                error: "bad_request",
                message: 'blob_store.kind must be "fs" or "s3"',
              });
            }
            // NO enum on storage class (#405): S3-compatibles define their own
            // names, so the endpoint, not this route, decides what it accepts.
            const storageClass = (blobStore as Record<string, unknown>)
              .storageClass;
            if (storageClass === null) {
              policyPatch.storageClass = null;
              delete (blobStore as Record<string, unknown>).storageClass;
            } else if (storageClass !== undefined) {
              if (
                typeof storageClass !== "string" ||
                storageClass.trim() === ""
              ) {
                return sendJson(res, 400, {
                  error: "bad_request",
                  message: "blob_store.storageClass must be a non-empty string",
                });
              }
              (blobStore as Record<string, unknown>).storageClass =
                storageClass.trim();
              policyPatch.storageClass = storageClass.trim();
              delete (blobStore as Record<string, unknown>).storageClass;
            }
            const throttle = (blobStore as Record<string, unknown>)
              .throttleBytesPerSec;
            if (throttle === null) {
              policyPatch.throttleBytesPerSec = null;
              delete (blobStore as Record<string, unknown>).throttleBytesPerSec;
            } else if (throttle !== undefined) {
              if (
                typeof throttle !== "number" ||
                !Number.isFinite(throttle) ||
                throttle <= 0
              ) {
                return sendJson(res, 400, {
                  error: "bad_request",
                  message:
                    "blob_store.throttleBytesPerSec must be a positive number",
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
            mediaLocation !== "keep" &&
            mediaLocation !== "strip"
          ) {
            return sendJson(res, 400, {
              error: "bad_request",
              message: 'media_location must be "keep" or "strip"',
            });
          }

          // Coordinates come off the connection row, gated on the recovery kit
          // before this vault starts replicating off-box (#367).
          let blobStorePatch = blobStore as
            | Record<string, unknown>
            | null
            | undefined;
          let recoveryKitConfirmed: boolean | undefined;
          if (blobStorePatch?.["encrypt"] === false) {
            return sendJson(res, 400, {
              error: "bad_request",
              message: "remote CAS encryption cannot be disabled",
            });
          }
          const connectionId =
            blobStorePatch && typeof blobStorePatch["connectionId"] === "string"
              ? (blobStorePatch["connectionId"] as string)
              : undefined;
          if (connectionId && options.storageConnections) {
            const connection =
              await options.storageConnections.get(connectionId);
            if (!connection) {
              return sendJson(res, 400, {
                error: "bad_request",
                message: `unknown storage connection "${connectionId}"`,
              });
            }
            const status = await options.recoveryKit?.status();
            recoveryKitConfirmed =
              status?.confirmedAt !== null && status?.confirmedAt !== undefined;
            if (options.recoveryKit && !recoveryKitConfirmed) {
              return sendJson(res, 409, {
                error: "recovery_kit_not_confirmed",
                recoveryKitConfirmed: false,
                message:
                  "export, re-select, and verify the recovery kit before enabling a remote storage tier",
              });
            }
            // A provider's coordinates aren't known until a grant is requested
            // and never rotate per-grant, so this round-trips once, at attach.
            const target =
              connection.kind === "provider" &&
              !connection.endpoint &&
              options.storageConnections
                ? await ensureProviderCasTarget(
                    options.storageConnections,
                    connectionId
                  )
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
              // Absent ⇒ derivatives stay on cas — graceful degradation (#425).
              ...("derivedPrefix" in target && target.derivedPrefix
                ? { derivedPrefix: target.derivedPrefix }
                : {}),
              // Direct-to-cold engages only when STANDARD_IA is here (#425).
              ...("supportedStorageClasses" in target &&
              target.supportedStorageClasses
                ? { supportedStorageClasses: target.supportedStorageClasses }
                : {}),
            };
          }
          if (blobStorePatch?.["kind"] === "s3") {
            blobStorePatch = { ...blobStorePatch, encrypt: true };
          }

          const remoteIdentity = (value: Record<string, unknown>): string =>
            JSON.stringify(
              [
                "connectionId",
                "endpoint",
                "region",
                "bucket",
                "prefix",
                "derivedPrefix",
              ].map((key) => value[key])
            );
          const attachingRemote =
            blobStorePatch?.["kind"] === "s3" &&
            (priorBlobStore.kind !== "s3" ||
              remoteIdentity(
                priorBlobStore as unknown as Record<string, unknown>
              ) !== remoteIdentity(blobStorePatch));
          // Seed the outbox BEFORE the settings write: a crash before it
          // leaves harmless obligations, a crash after it would omit old local
          // bytes from remote-primary custody.
          if (attachingRemote) {
            // Replica evidence is scoped to the old target though the table has
            // no target column — clear it before seeding, or resident bytes
            // never reach the new store.
            plane.db.blobTransfers.resetRemoteEvidence();
            plane.db.blobTransfers.enqueueExistingLocal();
          }
          updateBlobStoreSettings(plane.db, {
            ...(blobStorePatch === undefined
              ? {}
              : { blob_store: blobStorePatch }),
            ...(mediaLocation === undefined
              ? {}
              : { media_location: mediaLocation as "keep" | "strip" | null }),
          });
          if (Object.keys(policyPatch).length > 0)
            updateBackupPolicy(plane.db.vault, policyPatch);
          if (attachingRemote) plane.db.blobTransfers.kickOutbox();
          const remoteWithoutBackup =
            attachingRemote &&
            options.gatewayDatabase !== undefined &&
            options.gatewayDatabase.db
              .prepare(
                "SELECT 1 AS present FROM backup_targets WHERE vault_id = ?"
              )
              .get(plane.boot.vaultId) === undefined;
          return sendJson(res, 200, {
            blob_store: readBlobStoreSettings(plane.db.vault),
            media_location: mediaLocationPolicy(plane.db),
            ...(recoveryKitConfirmed === undefined
              ? {}
              : { recoveryKitConfirmed }),
            ...(remoteWithoutBackup
              ? {
                  warning:
                    "Remote CAS is storing offsite bytes without a backup target; " +
                    "the recovery kit cannot restore those bytes.",
                }
              : {}),
          });
        }
      }

      // The #807 cascade is a SIBLING resource under the same prefix
      // (`vault-enrich-rules-routes.ts`): the tier's own request/response
      // bodies must stay unchanged byte for byte.
      if (segments[0] === "enrich" && segments.length > 1) {
        const handled = await handleEnrichCascadeRoute({
          req,
          res,
          method,
          segments: segments.slice(1),
          url,
          plane,
          ...(options.enrichCapabilityKnown
            ? { options: { capabilityKnown: options.enrichCapabilityKnown } }
            : {}),
        });
        if (handled) return true;
      }
      if (segments[0] === "enrich" && segments.length === 1) {
        if (method === "GET") {
          return sendJson(res, 200, {
            enrich: readEnrichSettings(plane.db),
            // Additive (#807): clients reading only `enrich` are unaffected.
            rules: enrichRulesFor(plane),
          });
        }
        if (method === "PUT") {
          const body = await readJson(req);
          const patch: Partial<Record<"photos" | "docs", EnrichTier | null>> =
            {};
          for (const key of ["photos", "docs"] as const) {
            const v = body[key];
            if (v === undefined) continue;
            if (
              v !== null &&
              v !== "off" &&
              v !== "device" &&
              v !== "gateway"
            ) {
              return sendJson(res, 400, {
                error: "bad_request",
                message: `${key} must be "off", "device", "gateway" or null`,
              });
            }
            patch[key] = v as EnrichTier | null;
          }
          const before = readEnrichSettings(plane.db);
          updateEnrichSettings(plane.db, patch);
          const after = readEnrichSettings(plane.db);
          // `enrichRefusalNotice` describes the tier in force, so leaving it up
          // would assert a dead setting. Archived, not deleted.
          for (const domain of ["photos", "docs"] as const) {
            if (before[domain] === after[domain]) continue;
            const stale = plane.notices.getBySource("enrichment", domain);
            if (stale) plane.notices.archive(stale.noticeId);
          }
          return sendJson(res, 200, { enrich: after });
        }
      }

      if (method === "GET" && segments[0] === "apps" && segments.length === 1) {
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

      if (
        method === "POST" &&
        segments[0] === "apps" &&
        segments[2] === "grants"
      ) {
        const appId = segments[1] ?? "";
        const body = await readJson(req);
        const request = parseGrantRequest(body);
        if (!request) {
          return sendJson(res, 400, {
            error: "bad_request",
            message:
              "grant body needs {purpose: string, scopes: [{schema, verbs, table?}]}",
          });
        }
        try {
          const grantId = plane.approveGrant(appId, request);
          return sendJson(res, 200, { grantId });
        } catch (error) {
          return sendJson(res, 400, {
            error: "grant_refused",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // The explicit second half of uninstall (#286): uninstall RETAINS the
      // app's ext band, this drops its tables + registry rows for good.
      if (
        method === "POST" &&
        segments[0] === "apps" &&
        segments[2] === "purge-ext" &&
        segments.length === 3
      ) {
        const appId = segments[1] ?? "";
        try {
          return sendJson(res, 200, plane.purgeAppExt(appId));
        } catch (error) {
          return sendJson(res, 400, {
            error: "purge_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        method === "GET" &&
        segments[0] === "agents" &&
        segments.length === 1
      ) {
        return sendJson(res, 200, { agents: plane.listAgents() });
      }

      if (
        method === "POST" &&
        segments[0] === "agents" &&
        segments[2] === "grants"
      ) {
        const appId = segments[1] ?? "";
        const body = await readJson(req);
        const request = parseGrantRequest(body);
        if (!request) {
          return sendJson(res, 400, {
            error: "bad_request",
            message:
              "grant body needs {purpose: string, scopes: [{schema, verbs, table?}]}",
          });
        }
        try {
          const displayName = await options.resolveAutomationName?.(appId);
          const grantId = plane.approveAgentGrant(appId, request, displayName);
          return sendJson(res, 200, { grantId });
        } catch (error) {
          return sendJson(res, 400, {
            error: "grant_refused",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        method === "GET" &&
        segments[0] === "apps" &&
        segments.length === 3 &&
        segments[2] === "scopes"
      ) {
        return sendJson(res, 200, plane.scopeSurface(segments[1] ?? ""));
      }

      if (
        method === "DELETE" &&
        segments[0] === "grants" &&
        segments.length === 2
      ) {
        try {
          const result = plane.revokeGrant(segments[1] ?? "");
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 404, {
            error: "revoke_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        method === "GET" &&
        segments[0] === "parked" &&
        segments.length === 1
      ) {
        // Mobile polls this and the list is usually unchanged (#659).
        return sendJsonConditional(req, res, 200, {
          parked: plane.listParked(),
        });
      }

      if (
        method === "GET" &&
        segments[0] === "outbox" &&
        segments.length === 1
      ) {
        const statusParam = url.searchParams.get("status");
        const statuses = statusParam
          ? statusParam
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        return sendJson(res, 200, {
          items: withCanEdit(plane.listOutbox(statuses)),
        });
      }

      if (
        method === "POST" &&
        segments[0] === "outbox" &&
        segments.length === 2
      ) {
        const body = await readJson(req);
        if (body.decision !== "approve" && body.decision !== "discard") {
          return sendJson(res, 400, {
            error: "bad_request",
            message:
              'outbox decision body needs {decision: "approve" | "discard"}',
          });
        }
        // The owner surface edits the ARTIFACT only — the wire request carries
        // `{{connection:…}}` placeholders it never parses. A raw `request` is
        // refused outright, never ignored, so no caller thinks an edit landed.
        if (body.request !== undefined) {
          return sendJson(res, 400, {
            error: "bad_request",
            message:
              'the outbox route never accepts a raw "request" from the owner surface — edit the artifact and the gateway rebuilds the wire request server-side',
          });
        }
        const itemId = segments[1] ?? "";
        let rebuiltRequest: Record<string, unknown> | undefined;
        if (isRecord(body.artifact)) {
          // Discarding sends nothing, so an edit could change no outcome.
          if (body.decision !== "approve") {
            return sendJson(res, 400, {
              error: "bad_request",
              message:
                'an artifact edit only applies to "approve" — discarding sends nothing, so there is nothing to edit',
            });
          }
          const original = plane.rawOutboxItem(itemId);
          if (!original) {
            return sendJson(res, 404, {
              error: "not_found",
              message: `no outbox item ${itemId}`,
            });
          }
          const rebuild = rebuilderForVerb(original.verb);
          if (!rebuild) {
            return sendJson(res, 400, {
              error: "edit_unsupported",
              message: `editing isn't supported for ${original.verb} yet — approve or deny as staged`,
            });
          }
          try {
            assertArtifactShapeUnchanged(original.artifact, body.artifact);
            rebuiltRequest = rebuild(
              original.request as unknown as OutboxWireRequest,
              body.artifact
            ) as unknown as Record<string, unknown>;
          } catch (error) {
            return sendJson(res, 400, {
              error: "bad_request",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const outcome = await plane.decideOutbox({
          itemId,
          decision: body.decision,
          ...(isRecord(body.artifact) ? { artifact: body.artifact } : {}),
          ...(rebuiltRequest ? { request: rebuiltRequest } : {}),
          ...(typeof body.always_allow === "boolean"
            ? { alwaysAllow: body.always_allow }
            : {}),
          ...(typeof body.note === "string" ? { note: body.note } : {}),
        });
        if (outcome.status === "executed" && body.decision === "approve") {
          options.onOutboxDecided?.(plane);
        }
        return sendJson(
          res,
          outcome.status === "executed" ? 200 : 409,
          outcome
        );
      }

      if (
        method === "GET" &&
        segments[0] === "outbox-grants" &&
        segments.length === 1
      ) {
        return sendJson(res, 200, { grants: plane.listOutboxGrants() });
      }

      if (
        method === "DELETE" &&
        segments[0] === "outbox-grants" &&
        segments.length === 2
      ) {
        const outcome = await plane.revokeOutboxGrant(segments[1] ?? "");
        return sendJson(
          res,
          outcome.status === "executed" ? 200 : 409,
          outcome
        );
      }

      if (
        method === "GET" &&
        segments[0] === "blocking" &&
        segments.length === 1
      ) {
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
        return sendJson(res, 200, {
          ...blocking,
          outbox: withCanEdit(blocking.outbox),
        });
      }

      if (
        method === "GET" &&
        segments[0] === "notifications" &&
        segments.length === 1
      ) {
        const notifications = plane.notificationsSummary(
          url.searchParams.get("include_archived") === "true"
        );
        // Each projection ETags its OWN body (#659), so a grant-profiled
        // caller can never revalidate into the other shape's cached response.
        if (vaultContext()?.grantProfile !== undefined) {
          return sendJsonConditional(req, res, 200, {
            count: notifications.decisions.count,
          });
        }
        return sendJsonConditional(req, res, 200, {
          ...notifications,
          decisions: {
            ...notifications.decisions,
            outbox: withCanEdit(notifications.decisions.outbox),
          },
        });
      }

      if (
        method === "GET" &&
        segments[0] === "notifications" &&
        segments[1] === "events" &&
        segments.length === 2
      ) {
        if (!options.notificationsEvents) {
          return sendJson(res, 503, {
            error: "notifications_events_unavailable",
            message: "Notifications events are not configured on this gateway",
          });
        }
        const releaseSlot = notificationsSubscriberCap.admit(res);
        if (!releaseSlot) return true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const write = (): void => {
          if (!res.writableEnded)
            res.write(
              'event: notifications-changed\ndata: {"type":"notifications-changed"}\n\n'
            );
        };
        write();
        const unsubscribe = options.notificationsEvents.subscribe(
          plane.boot.vaultId,
          write
        );
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(": ping\n\n");
        }, 30_000);
        heartbeat.unref?.();
        let closed = false;
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          releaseSlot();
          if (!res.writableEnded) res.end();
        };
        req.on("close", cleanup);
        res.on("error", cleanup);
        return true;
      }

      if (
        method === "POST" &&
        segments[0] === "notifications" &&
        segments[1] === "notices" &&
        segments.length === 3
      ) {
        const body = await readJson(req);
        const action = body.action;
        if (action !== "read" && action !== "archive") {
          return sendJson(res, 400, {
            error: "bad_request",
            message: 'notice action must be "read" or "archive"',
          });
        }
        const notice =
          action === "read"
            ? plane.notices.markRead(segments[2] ?? "")
            : plane.notices.archive(segments[2] ?? "");
        return notice
          ? sendJson(res, 200, { notice })
          : sendJson(res, 404, {
              error: "notice_not_found",
              message: "Notice not found",
            });
      }

      // NO route here writes gateway health into Notifications (#665): health
      // is STATUS, not an owner decision, and lives on the Gateway page.

      if (
        method === "GET" &&
        segments[0] === "scope-requests" &&
        segments.length === 1
      ) {
        return sendJson(res, 200, { requests: plane.listScopeRequests() });
      }

      if (
        method === "POST" &&
        segments[0] === "scope-requests" &&
        segments.length === 2
      ) {
        const body = await readJson(req);
        if (typeof body.approve !== "boolean") {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "scope-request decision body needs {approve: boolean}",
          });
        }
        try {
          const request = plane.decideScopeRequest(
            segments[1] ?? "",
            body.approve
          );
          return sendJson(res, 200, { request, approved: body.approve });
        } catch (error) {
          return sendJson(res, 404, {
            error: "decide_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        method === "GET" &&
        segments[0] === "review" &&
        segments.length === 1
      ) {
        const limitParam = Number(url.searchParams.get("limit"));
        return sendJson(res, 200, {
          entries: plane.reviewFeed(
            Number.isFinite(limitParam) && limitParam > 0
              ? limitParam
              : undefined
          ),
        });
      }

      // Entity types are the ontology model, so @-tagging can name a kind
      // ("@core.event") with no matching vault row (#272).
      if (
        method === "GET" &&
        segments[0] === "entities" &&
        segments.length === 1
      ) {
        return sendJson(res, 200, { entities: listVaultEntities() });
      }

      // Computed on request: an owner ops screen, not a hot path (#441).
      if (
        method === "GET" &&
        segments[0] === "atlas" &&
        segments.length === 2
      ) {
        if (segments[1] === "stats") {
          return sendJson(
            res,
            200,
            atlasCensus(plane.db.vault, plane.db.journal)
          );
        }
        if (segments[1] === "graph") {
          // core_link aggregation stays a SEPARATE collection: FK ≠ core_link.
          return sendJson(res, 200, atlasGraph(plane.db.vault));
        }
        if (segments[1] === "pulse") {
          return sendJson(res, 200, atlasPulse(plane.db.journal));
        }
      }

      // Browse writes ride the journalled `atlas.*` pipeline, so every edit is
      // a receipted operator act and ships in the replica change log (#441).
      if (
        segments[0] === "atlas" &&
        segments[1] === "browse" &&
        segments.length === 3
      ) {
        const sub = segments[2];
        const table = url.searchParams.get("table") ?? "";
        try {
          if (method === "GET" && sub === "tables") {
            return sendJson(res, 200, {
              tables: browseTableList(plane.db.vault),
            });
          }
          if (method === "GET" && sub === "columns") {
            return sendJson(res, 200, browseColumns(plane.db.vault, table));
          }
          if (method === "GET" && sub === "rows") {
            const limitParam = Number(url.searchParams.get("limit"));
            const dirParam = url.searchParams.get("dir");
            return sendJson(
              res,
              200,
              browseRows(plane.db.vault, {
                table,
                ...(Number.isFinite(limitParam) && limitParam > 0
                  ? { limit: Math.min(limitParam, BROWSE_MAX_LIMIT) }
                  : {}),
                ...(url.searchParams.get("after")
                  ? { after: url.searchParams.get("after")! }
                  : {}),
                ...(url.searchParams.get("orderBy")
                  ? { orderBy: url.searchParams.get("orderBy")! }
                  : {}),
                ...(dirParam === "desc" ? { dir: "desc" as const } : {}),
              })
            );
          }
          if (method === "GET" && sub === "row") {
            return sendJson(
              res,
              200,
              browseRow(plane.db.vault, table, url.searchParams.get("id") ?? "")
            );
          }
          if (method === "GET" && sub === "ref-search") {
            return sendJson(res, 200, {
              hits: browseRefSearch(
                plane.db.vault,
                table,
                url.searchParams.get("query") ?? ""
              ),
            });
          }
          if (method === "GET" && sub === "dependents") {
            return sendJson(
              res,
              200,
              browseDependents(
                plane.db.vault,
                table,
                url.searchParams.get("id") ?? ""
              )
            );
          }
        } catch (error) {
          if (error instanceof BrowseError) {
            const status = error.code === "bad_request" ? 400 : 404;
            return sendJson(res, status, {
              error: error.code,
              message: error.message,
            });
          }
          throw error;
        }

        if (method === "POST" && sub === "insert") {
          const body = await readJson(req);
          return runBrowseWrite(res, plane, "atlas.insert_row", {
            table: body["table"],
            values: body["values"],
            ...(body["unlockMachinery"] === true
              ? { unlockMachinery: true }
              : {}),
          });
        }
        if (method === "POST" && sub === "update") {
          const body = await readJson(req);
          return runBrowseWrite(res, plane, "atlas.update_row", {
            table: body["table"],
            id: body["id"],
            set: body["set"],
            ...(body["unlockMachinery"] === true
              ? { unlockMachinery: true }
              : {}),
          });
        }
        if (method === "POST" && sub === "delete") {
          const body = await readJson(req);
          const delTable =
            typeof body["table"] === "string" ? body["table"] : "";
          const delId = typeof body["id"] === "string" ? body["id"] : "";
          // Preflight so a blocked delete returns the FULL dependent payload;
          // the command's own guard surfaces only a reason string.
          try {
            const deps = browseDependents(plane.db.vault, delTable, delId);
            if (deps.hasEngineDependents) {
              return sendJson(res, 409, {
                error: "has_dependents",
                message: `${deps.totalRows} row(s) reference this row`,
                dependents: deps.dependents,
                totalRows: deps.totalRows,
              });
            }
          } catch (error) {
            if (error instanceof BrowseError) {
              const status = error.code === "bad_request" ? 400 : 404;
              return sendJson(res, status, {
                error: error.code,
                message: error.message,
              });
            }
            throw error;
          }
          return runBrowseWrite(res, plane, "atlas.delete_row", {
            table: body["table"],
            id: body["id"],
            ...(body["unlockMachinery"] === true
              ? { unlockMachinery: true }
              : {}),
          });
        }
      }

      if (
        method === "GET" &&
        segments[0] === "picker" &&
        segments.length === 1
      ) {
        const term = url.searchParams.get("term") ?? undefined;
        const kindsParam = url.searchParams.get("kinds");
        const kinds = kindsParam
          ? kindsParam
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean)
          : undefined;
        const limitParam = Number(url.searchParams.get("limit"));
        return sendJson(
          res,
          200,
          plane.pickEntities({
            ...(term === undefined ? {} : { term }),
            ...(kinds ? { kinds } : {}),
            ...(Number.isFinite(limitParam) && limitParam > 0
              ? { limit: limitParam }
              : {}),
          })
        );
      }

      if (
        method === "GET" &&
        segments[0] === "anchors" &&
        segments.length === 1
      ) {
        const term = url.searchParams.get("term") ?? undefined;
        const limitParam = Number(url.searchParams.get("limit"));
        return sendJson(
          res,
          200,
          plane.pickAnchors({
            ...(term === undefined ? {} : { term }),
            ...(Number.isFinite(limitParam) && limitParam > 0
              ? { limit: limitParam }
              : {}),
          })
        );
      }

      if (
        method === "POST" &&
        segments[0] === "links" &&
        segments.length === 1
      ) {
        const body = await readJson(req);
        const fields = ["from_type", "from_id", "to_type", "to_id"] as const;
        if (fields.some((f) => typeof body[f] !== "string" || body[f] === "")) {
          return sendJson(res, 400, {
            error: "bad_request",
            message:
              "link body needs {from_type, from_id, to_type, to_id, relation?}",
          });
        }
        let selector: AnchorSelector | undefined;
        if (body.selector !== undefined) {
          selector = parseSelector(body.selector);
          if (selector === undefined) {
            return sendJson(res, 400, {
              error: "bad_request",
              message: "selector must be {exact, prefix, suffix, start}",
            });
          }
        }
        const outcome = await plane.linkAsOwner({
          from_type: body.from_type as string,
          from_id: body.from_id as string,
          to_type: body.to_type as string,
          to_id: body.to_id as string,
          ...(typeof body.relation === "string" && body.relation !== ""
            ? { relation: body.relation }
            : {}),
          ...(selector ? { selector } : {}),
        });
        return sendJson(res, 200, outcome);
      }

      if (
        method === "DELETE" &&
        segments[0] === "links" &&
        segments.length === 2
      ) {
        return sendJson(res, 200, await plane.unlinkAsOwner(segments[1] ?? ""));
      }

      // A locator write only (#282): `{selector: null}` demotes the reference
      // to strip-only, and the link judgment is untouched either way.
      if (
        method === "PATCH" &&
        segments[0] === "links" &&
        segments.length === 2
      ) {
        const body = await readJson(req);
        if (!("selector" in body)) {
          return sendJson(res, 400, {
            error: "bad_request",
            message:
              "anchor body needs {selector: {exact, prefix, suffix, start} | null}",
          });
        }
        const selector =
          body.selector === null ? null : parseSelector(body.selector);
        if (selector === undefined) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "selector must be {exact, prefix, suffix, start} or null",
          });
        }
        return sendJson(
          res,
          200,
          await plane.anchorAsOwner(segments[1] ?? "", selector)
        );
      }

      if (
        method === "POST" &&
        segments[0] === "parked" &&
        segments.length === 2
      ) {
        const body = await readJson(req);
        if (typeof body.approve !== "boolean") {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "confirmation body needs {approve: boolean}",
          });
        }
        try {
          const outcome = plane.confirmParked(segments[1] ?? "", body.approve);
          return sendJson(res, 200, outcome);
        } catch (error) {
          return sendJson(res, 404, {
            error: "confirm_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return sendJson(res, 404, {
        error: "not_found",
        message: "unknown _vault route",
      });
    } catch (error) {
      return sendJson(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

async function handleVaultsRoute(
  vaults: VaultRegistry,
  visibleVaults: () => VaultInfo[],
  options: VaultRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[]
): Promise<boolean> {
  try {
    if (method === "GET" && segments.length === 1) {
      // A directory that failed to mount has no plane and so is invisible in
      // `vaults`; reporting failures alongside separates "you have one vault"
      // from "one of two would not open" (#603). Entries carry a directory and
      // the mount error, never vault contents.
      return sendJson(res, 200, {
        vaults: visibleVaults(),
        failedMounts: vaults.failedMounts(),
      });
    }

    if (method === "POST" && segments.length === 1) {
      const deviceKey = vaultContext()?.deviceKey;
      const currentVaultId = vaultContext()?.vaultId;
      const current =
        deviceKey && currentVaultId && options.enrollments
          ? options.enrollments.get(deviceKey, currentVaultId)
          : undefined;
      if (!current || current.revoked || !options.enrollments) {
        return sendJson(res, 403, {
          error: "owner_required",
          message: "only an enrolled owner's device can create another vault",
        });
      }
      const body = await readJson(req);
      if (body.name !== undefined && typeof body.name !== "string") {
        return sendJson(res, 400, {
          error: "bad_request",
          message: "name must be a string",
        });
      }
      const created = vaults.create(
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : undefined
      );
      try {
        // `vault_owners` is the whole authority record (#726).
        options.enrollments.enroll({
          endpointId: current.endpointId,
          vaultIds: [created.vaultId],
          label: current.label,
          ...(current.platform ? { platform: current.platform } : {}),
          rememberDevice: current.rememberDevice,
        });
      } catch (error) {
        vaults.delete(created.vaultId);
        options.keys?.destroy(`${created.vaultId}.sealkey`);
        throw error;
      }
      return sendJson(res, 201, created);
    }

    if (method === "DELETE" && segments.length === 2) {
      return sendJson(res, 405, {
        error: "erase_ceremony_required",
        message: `POST ${ROUTES.vaultErase} with the exact vault name`,
      });
    }

    if (method === "PATCH" && segments.length === 2) {
      const vaultId = segments[1] ?? "";
      // A device may only touch what it can see.
      if (!visibleVaults().some((v) => v.vaultId === vaultId)) {
        return sendJson(res, 404, {
          error: "vault_not_found",
          message: `unknown vault "${vaultId}"`,
        });
      }
      const body = await readJson(req);
      const presentationKeys = ["color", "icon", "blurb"] as const;
      const hasPresentation = presentationKeys.some(
        (k) => body[k] !== undefined
      );
      if (body.name === undefined && !hasPresentation) {
        return sendJson(res, 400, {
          error: "bad_request",
          message:
            "update body needs {name?: string, color?: string, icon?: string, blurb?: string}",
        });
      }
      if (body.name !== undefined && typeof body.name !== "string") {
        return sendJson(res, 400, {
          error: "bad_request",
          message: "name must be a string",
        });
      }
      for (const k of presentationKeys) {
        if (
          body[k] !== undefined &&
          body[k] !== null &&
          typeof body[k] !== "string"
        ) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: `${k} must be a string`,
          });
        }
      }
      let info =
        typeof body.name === "string"
          ? vaults.rename(vaultId, body.name)
          : undefined;
      if (hasPresentation) {
        // Presentation lives IN the vault (#280), so it travels with an export.
        const patch: Partial<
          Record<"color" | "icon" | "blurb", string | null>
        > = {};
        for (const k of presentationKeys) {
          if (body[k] !== undefined) patch[k] = body[k] as string | null;
        }
        info = vaults.updatePresentation(vaultId, patch);
      }
      return sendJson(res, 200, info);
    }

    return sendJson(res, 404, {
      error: "not_found",
      message: "unknown _vault/vaults route",
    });
  } catch (error) {
    return sendRegistryError(res, error);
  }
}

/**
 * STRICT NOT NULL / CHECK violations and sealed-column or machinery refusals
 * all land here as a clean 4xx with a reason, never a crash (#441).
 */
async function runBrowseWrite(
  res: ServerResponse,
  plane: VaultPlane,
  command: string,
  input: Record<string, unknown>
): Promise<boolean> {
  const outcome = await plane.invoke(plane.ownerCredential, {
    command,
    input,
    purpose: "dpv:ServiceProvision",
  });
  if (outcome.status === "executed") {
    return sendJson(res, 200, {
      ok: true,
      ...(outcome.output as Record<string, unknown>),
    });
  }
  if (outcome.status === "replayed") {
    return sendJson(res, 200, {
      ok: true,
      ...(outcome.output as Record<string, unknown>),
    });
  }
  return sendJson(res, outcome.status === "denied" ? 403 : 400, {
    ok: false,
    error: outcome.reason,
  });
}

function sendRegistryError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof VaultRegistryError) {
    const status = err.code === "vault_not_found" ? 404 : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  return sendJson(res, 500, {
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Undefined on anything malformed — the routes turn that into a 400 (#282). */
function parseSelector(raw: unknown): AnchorSelector | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.exact !== "string" || s.exact.length === 0) return undefined;
  if (typeof s.prefix !== "string" || typeof s.suffix !== "string")
    return undefined;
  if (typeof s.start !== "number" || !Number.isInteger(s.start) || s.start < 0)
    return undefined;
  return { exact: s.exact, prefix: s.prefix, suffix: s.suffix, start: s.start };
}

const VERBS = new Set(["read", "read+act", "act", "reveal"]);
const FILTER_OPS = new Set([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is-null",
  "not-null",
  "within-days",
  "within-next-days",
]);

function parseGrantRequest(
  body: Record<string, unknown>
): GrantRequest | undefined {
  if (typeof body.purpose !== "string" || body.purpose.length === 0)
    return undefined;
  if (!Array.isArray(body.scopes) || body.scopes.length === 0) return undefined;
  const scopes: GrantRequest["scopes"] = [];
  for (const raw of body.scopes) {
    if (raw === null || typeof raw !== "object") return undefined;
    const s = raw as Record<string, unknown>;
    if (typeof s.schema !== "string" || s.schema.length === 0) return undefined;
    if (typeof s.verbs !== "string" || !VERBS.has(s.verbs)) return undefined;
    if (s.table !== undefined && typeof s.table !== "string") return undefined;
    if (
      (s.rowFilter !== undefined || s.fieldMask !== undefined) &&
      (typeof s.table !== "string" || s.table === "")
    ) {
      return undefined;
    }
    let rowFilter: GrantRequest["scopes"][number]["rowFilter"];
    if (s.rowFilter !== undefined) {
      if (!Array.isArray(s.rowFilter) || s.rowFilter.length === 0)
        return undefined;
      rowFilter = [];
      for (const rawClause of s.rowFilter) {
        if (
          rawClause === null ||
          typeof rawClause !== "object" ||
          Array.isArray(rawClause)
        ) {
          return undefined;
        }
        const clause = rawClause as Record<string, unknown>;
        if (
          typeof clause.column !== "string" ||
          clause.column === "" ||
          typeof clause.op !== "string" ||
          !FILTER_OPS.has(clause.op)
        ) {
          return undefined;
        }
        rowFilter.push({
          column: clause.column,
          op: clause.op as NonNullable<
            GrantRequest["scopes"][number]["rowFilter"]
          >[number]["op"],
          ...(Object.hasOwn(clause, "value") ? { value: clause.value } : {}),
        });
      }
    }
    let fieldMask: string[] | undefined;
    if (s.fieldMask !== undefined) {
      if (
        !Array.isArray(s.fieldMask) ||
        s.fieldMask.length === 0 ||
        !s.fieldMask.every((field) => typeof field === "string" && field !== "")
      ) {
        return undefined;
      }
      fieldMask = [...s.fieldMask] as string[];
    }
    scopes.push({
      schema: s.schema,
      verbs: s.verbs as "read" | "read+act" | "act" | "reveal",
      ...(typeof s.table === "string" ? { table: s.table } : {}),
      ...(rowFilter ? { rowFilter } : {}),
      ...(fieldMask ? { fieldMask } : {}),
    });
  }
  return {
    purpose: body.purpose,
    scopes,
    ...(typeof body.expiresAt === "string"
      ? { expiresAt: body.expiresAt }
      : {}),
  };
}
