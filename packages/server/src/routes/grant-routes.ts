/*
 * The GRANT PLANE's owner surface (#825) — `/centraid/_vault/grants`.
 *
 * A share is a standing grant: who may see or edit which subject, until it is
 * revoked. Nothing here hands over a copy. Three reads stay distinct —
 * AUDIENCE-FIRST `?partyId=` (primary, ruling G-audience) unions a party's own
 * grants with the circle grants she is on the roster of; LITERAL AUDIENCE is
 * the row-level truth and never merges the two; SUBJECT-FIRST is the object side.
 *
 * ABSENT IS NEVER EMPTY on every read here: unreadable is `not_found`, an
 * unknown audience is `audience_not_found`, an unreached party carries
 * `channel: null`, an undelivered grant carries `fulfillment: []`. Only the
 * SUBJECT read cannot split this way — subject ids are app-polymorphic, so no
 * existence check belongs at this layer. A subject type with no fulfillment
 * strategy is refused at the door, naming what the vault does answer (#750).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "@centraid/core/protocol";
import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import {
  audienceExists,
  channelForParty,
  createShareGrant,
  isOfferableSubjectType,
  listFulfillment,
  listLiveGrantsReachingParty,
  listShareGrantsForAudience,
  listShareGrantsForSubject,
  readShareGrant,
  revokeShareGrant,
  shareSubjectDeclaration,
  SHARE_SUBJECT_REGISTRY,
  UnofferableSubjectError,
} from "@centraid/vault";
import type {
  ShareGrantAudience,
  ShareGrantAudienceKind,
  ShareGrantCapability,
  ShareGrantRecord,
  VaultDb,
} from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type {
  GrantFulfillmentHost,
  GrantRemovalReport,
} from "../serve/grant-fulfillment.js";
import {
  fulfillGrant,
  propagateGrantRemoval,
} from "../serve/grant-fulfillment.js";
import { readJson, sendJson } from "./route-helpers.js";

export const GRANTS_PATH = ROUTES.vaultGrants;
const SUBJECTS_PATH = ROUTES.vaultGrantSubjects;

export interface GrantVault {
  vaultId: string;
  db: VaultDb;
  ownerPartyId: string;
}

export interface GrantRouteDeps {
  enrollments: EnrollmentStore;
  /** Route security: vaultScope `active`. */
  currentVault: () => GrantVault | undefined;
  host: GrantFulfillmentHost;
  now?: () => string;
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function grantWire(
  db: VaultDb,
  grant: ShareGrantRecord
): Record<string, unknown> {
  return {
    grantId: grant.grantId,
    audience: grant.audience,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    capability: grant.capability,
    grantedAt: grant.grantedAt,
    revokedAt: grant.revokedAt,
    grantedBy: grant.grantedBy,
    maxSizeBytes: grant.maxSizeBytes,
    // `[]` is "no audience vault addressed yet", never "could not be read".
    fulfillment: listFulfillment(db.vault, grant.grantId),
  };
}

function grantsWire(
  db: VaultDb,
  grants: readonly ShareGrantRecord[]
): Record<string, unknown>[] {
  return grants.map((grant) => grantWire(db, grant));
}

function stringField(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function subjectsWire(): Record<string, unknown>[] {
  return SHARE_SUBJECT_REGISTRY.map((entry) => ({
    subjectType: entry.subjectType,
    capabilities: entry.fulfillment.edit ? ["view", "edit"] : ["view"],
    fulfillment: entry.fulfillment,
  }));
}

function refusalCopy(
  subjectType: string,
  capability: ShareGrantCapability
): string {
  const declared = shareSubjectDeclaration(subjectType);
  if (!declared)
    return `${subjectType} is not something this vault can share; nothing here can keep that grant true`;
  return `${subjectType} can be shared for view, not for ${capability}; editing it is not offered yet`;
}

function badRequest(res: ServerResponse, error: string, message: string): true {
  return sendJson(res, 400, { error, message });
}

async function createGrant(
  req: IncomingMessage,
  res: ServerResponse,
  vault: GrantVault,
  deps: GrantRouteDeps
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return badRequest(res, "invalid_body", "the request body must be JSON");
  }
  const audienceKind = stringField(body, "audienceKind");
  const audienceId = stringField(body, "audienceId");
  const subjectType = stringField(body, "subjectType");
  const subjectId = stringField(body, "subjectId");
  const capability = stringField(body, "capability") ?? "view";
  if (audienceKind !== "party" && audienceKind !== "circle")
    return badRequest(
      res,
      "invalid_audience",
      "audienceKind must be party or circle"
    );
  if (!audienceId || !subjectType || !subjectId)
    return badRequest(
      res,
      "invalid_grant",
      "a grant needs audienceId, subjectType and subjectId"
    );
  if (capability !== "view" && capability !== "edit")
    return badRequest(
      res,
      "invalid_capability",
      "capability must be view or edit; comment is reserved and unimplemented"
    );
  if (!isOfferableSubjectType(subjectType))
    return badRequest(
      res,
      "subject_not_offerable",
      refusalCopy(subjectType, capability)
    );
  const audience: ShareGrantAudience = {
    kind: audienceKind as ShareGrantAudienceKind,
    id: audienceId,
  };
  const now = (deps.now ?? ((): string => new Date().toISOString()))();
  let created;
  try {
    created = createShareGrant(vault.db.vault, {
      audience,
      subjectType,
      subjectId,
      capability,
      grantedAt: now,
      grantedBy: vault.ownerPartyId,
      ...(typeof body.maxSizeBytes === "number"
        ? { maxSizeBytes: body.maxSizeBytes }
        : {}),
    });
  } catch (error) {
    if (error instanceof UnofferableSubjectError)
      return badRequest(
        res,
        "capability_not_offerable",
        refusalCopy(subjectType, capability)
      );
    throw error;
  }
  // Fulfillment runs on the gesture, not a later sweep, so the answer says
  // where the share got to rather than promising it will be looked at.
  const pass = fulfillGrant({
    host: deps.host,
    originVaultId: vault.vaultId,
    grantId: created.grantId,
    ...(stringField(body, "subjectLabel") === undefined
      ? {}
      : { subjectLabel: stringField(body, "subjectLabel")! }),
    now,
  });
  const grant =
    readShareGrant(vault.db.vault, created.grantId) ?? created.grant;
  return sendJson(res, created.outcome === "created" ? 201 : 200, {
    outcome: created.outcome,
    grant: grantWire(vault.db, grant),
    fulfillmentPass: pass,
  });
}

/** Derived from what happened, never a constant: three honest removal answers
 *  must not be paraphrased into one optimistic one. */
function revocationMessage(removal: GrantRemovalReport): string {
  if (removal.outcome === "failed")
    return `the share is revoked, but its removal could not be sent: ${removal.reason}`;
  const steps = removal.result.steps;
  if (steps.some((step) => step.state === "remove_sent"))
    return "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed";
  if (steps.some((step) => step.removed === true))
    return "no longer shared; every copy it delivered has been removed";
  return "no longer shared; no delivered copy remains — nothing needed removing";
}

function revokeGrant(
  res: ServerResponse,
  vault: GrantVault,
  grantId: string,
  deps: GrantRouteDeps
): true {
  const now = (deps.now ?? ((): string => new Date().toISOString()))();
  const revoked = revokeShareGrant(vault.db.vault, { grantId, revokedAt: now });
  if (revoked.outcome === "absent")
    return sendJson(res, 404, { error: "not_found" });
  // Already-revoked propagates again on purpose: that is the owner's retry.
  const removal = propagateGrantRemoval({
    host: deps.host,
    originVaultId: vault.vaultId,
    grantId,
    now,
  });
  const grant = readShareGrant(vault.db.vault, grantId);
  return sendJson(res, 200, {
    outcome: revoked.outcome,
    ...(grant ? { grant: grantWire(vault.db, grant) } : {}),
    removal,
    message: revocationMessage(removal),
  });
}

function listGrants(res: ServerResponse, vault: GrantVault, url: URL): boolean {
  const db = vault.db;
  const partyId = url.searchParams.get("partyId");
  if (partyId) {
    if (!audienceExists(db.vault, { kind: "party", id: partyId }))
      return sendJson(res, 404, {
        error: "audience_not_found",
        message: "this vault knows no such person",
      });
    return sendJson(res, 200, {
      partyId,
      // `null` is "never reached them", not a severed channel.
      channel: channelForParty(db.vault, partyId),
      grants: grantsWire(db, listLiveGrantsReachingParty(db.vault, partyId)),
    });
  }
  const includeRevoked = url.searchParams.get("includeRevoked") === "1";
  const audienceKind = url.searchParams.get("audienceKind");
  const audienceId = url.searchParams.get("audienceId");
  if (audienceKind && audienceId) {
    if (audienceKind !== "party" && audienceKind !== "circle")
      return badRequest(
        res,
        "invalid_audience",
        "audienceKind must be party or circle"
      );
    if (!audienceExists(db.vault, { kind: audienceKind, id: audienceId }))
      return sendJson(res, 404, {
        error: "audience_not_found",
        message:
          audienceKind === "party"
            ? "this vault knows no such person"
            : "this vault knows no such circle",
      });
    return sendJson(res, 200, {
      audience: { kind: audienceKind, id: audienceId },
      grants: grantsWire(
        db,
        listShareGrantsForAudience(
          db.vault,
          { kind: audienceKind, id: audienceId },
          { includeRevoked }
        )
      ),
    });
  }
  const subjectType = url.searchParams.get("subjectType");
  const subjectId = url.searchParams.get("subjectId");
  if (subjectType && subjectId) {
    if (!isOfferableSubjectType(subjectType))
      return badRequest(
        res,
        "subject_not_offerable",
        refusalCopy(subjectType, "view")
      );
    return sendJson(res, 200, {
      subject: { subjectType, subjectId },
      grants: grantsWire(
        db,
        listShareGrantsForSubject(db.vault, subjectType, subjectId, {
          includeRevoked,
        })
      ),
    });
  }
  return badRequest(
    res,
    "query_required",
    "ask by partyId, by audienceKind and audienceId, or by subjectType and subjectId"
  );
}

export function makeGrantRouteHandler(deps: GrantRouteDeps): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (
      url.pathname !== GRANTS_PATH &&
      !url.pathname.startsWith(`${GRANTS_PATH}/`)
    )
      return false;
    const method = (req.method ?? "GET").toUpperCase();
    const deviceId = callerDeviceId(req);
    const owner = deviceId ? deps.enrollments.ownerFor(deviceId) : undefined;
    if (!owner)
      return sendJson(res, 403, { error: "device_identity_required" });

    // The registry discloses nothing about any vault, so it answers before one
    // is chosen.
    if (url.pathname === SUBJECTS_PATH) {
      if (method !== "GET")
        return sendJson(res, 405, { error: "method_not_allowed" });
      return sendJson(res, 200, { subjects: subjectsWire() });
    }

    const vault = deps.currentVault();
    if (!vault)
      return sendJson(res, 409, {
        error: "vault_unavailable",
        message: "no vault is mounted for this request",
      });
    // A vault this owner does not hold is nothing at all, not a refusal.
    if (deps.enrollments.owners.ownerOf(vault.vaultId) !== owner.ownerId)
      return sendJson(res, 404, { error: "not_found" });

    if (url.pathname === GRANTS_PATH) {
      if (method === "GET") return listGrants(res, vault, url);
      if (method === "POST") return createGrant(req, res, vault, deps);
      return sendJson(res, 405, { error: "method_not_allowed" });
    }

    const rest = url.pathname.slice(`${GRANTS_PATH}/`.length).split("/");
    const grantId = decodeURIComponent(rest[0] ?? "");
    if (!grantId) return sendJson(res, 404, { error: "not_found" });
    if (rest.length === 2 && rest[1] === "revoke") {
      if (method !== "POST")
        return sendJson(res, 405, { error: "method_not_allowed" });
      return revokeGrant(res, vault, grantId, deps);
    }
    if (rest.length !== 1) return sendJson(res, 404, { error: "not_found" });
    if (method !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" });
    const grant = readShareGrant(vault.db.vault, grantId);
    if (!grant) return sendJson(res, 404, { error: "not_found" });
    return sendJson(res, 200, { grant: grantWire(vault.db, grant) });
  };
}
