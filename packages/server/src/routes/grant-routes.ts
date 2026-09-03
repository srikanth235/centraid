import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "@centraid/core/protocol";
import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import {
  audienceExists,
  channelForParty,
  enforcementLocus,
  grantPhrase,
  isOfferableSubjectType,
  isRegisteredAuthority,
  listFulfillment,
  listLiveGrantsReachingParty,
  listShareGrantsForAudience,
  listShareGrantsForSubject,
  readShareGrant,
  registeredVerbs,
  revokePromiseCopy,
  shareSubjectDeclaration,
  SHARE_SUBJECT_REGISTRY,
  unregisteredVerbCopy,
} from "@centraid/vault";
import type {
  InvokeOutcome,
  ShareGrantAudienceKind,
  ShareGrantCapability,
  ShareGrantRecord,
  VaultDb,
} from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import { readJson, sendJson } from "./route-helpers.js";

export const GRANTS_PATH = ROUTES.vaultGrants;
const SUBJECTS_PATH = ROUTES.vaultGrantSubjects;

export interface GrantVault {
  vaultId: string;
  db: VaultDb;
  ownerPartyId: string;
  invoke: (
    command: string,
    input: Record<string, unknown>
  ) => Promise<InvokeOutcome>;
}

export interface GrantRouteDeps {
  enrollments: EnrollmentStore;
  currentVault: () => GrantVault | undefined;
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
  const fulfillment = listFulfillment(db.vault, grant.grantId);
  const locus = enforcementLocus(
    grant.audience.kind === "party" ? "person" : "circle"
  );
  return {
    locus,
    promise: revokePromiseCopy(locus),
    grantId: grant.grantId,
    audience: grant.audience,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    capability: grant.capability,
    grantedAt: grant.grantedAt,
    revokedAt: grant.revokedAt,
    grantedBy: grant.grantedBy,
    maxSizeBytes: grant.maxSizeBytes,
    fulfillment,
    ...grantPhrase({ revokedAt: grant.revokedAt, fulfillment, locus }),
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

function lociWire(): Record<string, string> {
  return Object.fromEntries(
    (["person", "device", "harness"] as const).map((kind) => {
      const locus = enforcementLocus(kind);
      return [locus, revokePromiseCopy(locus)];
    })
  );
}

function refusalCopy(
  subjectType: string,
  capability: ShareGrantCapability
): string {
  if (!shareSubjectDeclaration(subjectType))
    return unregisteredVerbCopy({ subjectType, verb: capability, offered: [] });
  return unregisteredVerbCopy({
    subjectType,
    verb: capability,
    offered: registeredVerbs("person", subjectType),
  });
}

function badRequest(res: ServerResponse, error: string, message: string): true {
  return sendJson(res, 400, { error, message });
}

function refused(res: ServerResponse, outcome: InvokeOutcome): true {
  const reason =
    "reason" in outcome && typeof outcome.reason === "string"
      ? outcome.reason
      : outcome.status;
  if (outcome.status === "parked")
    return sendJson(res, 202, {
      error: "awaiting_confirmation",
      message: reason,
    });
  return sendJson(res, outcome.status === "denied" ? 403 : 400, {
    error: "grant_refused",
    message: reason,
  });
}

async function createGrant(
  req: IncomingMessage,
  res: ServerResponse,
  vault: GrantVault
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
  if (
    !isRegisteredAuthority(
      audienceKind === "party" ? "person" : "circle",
      subjectType,
      capability
    )
  )
    return badRequest(
      res,
      "capability_not_offerable",
      refusalCopy(subjectType, capability)
    );
  const outcome = await vault.invoke("share.grant", {
    audience_kind: audienceKind satisfies ShareGrantAudienceKind,
    audience_id: audienceId,
    subject_type: subjectType,
    subject_id: subjectId,
    verb: capability,
    ...(typeof body.maxSizeBytes === "number"
      ? { max_size_bytes: body.maxSizeBytes }
      : {}),
  });
  if (outcome.status !== "executed") return refused(res, outcome);
  const output = outcome.output as { grant_id: string; outcome: string };
  const grant = readShareGrant(vault.db.vault, output.grant_id);
  if (!grant) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, output.outcome === "created" ? 201 : 200, {
    outcome: output.outcome,
    grant: grantWire(vault.db, grant),
  });
}

async function revokeGrant(
  res: ServerResponse,
  vault: GrantVault,
  grantId: string
): Promise<true> {
  const outcome = await vault.invoke("share.revoke", { grant_id: grantId });
  if (outcome.status !== "executed") return refused(res, outcome);
  const output = outcome.output as { outcome: string };
  if (output.outcome === "absent")
    return sendJson(res, 404, { error: "not_found" });
  const grant = readShareGrant(vault.db.vault, grantId);
  const wire = grant ? grantWire(vault.db, grant) : undefined;
  return sendJson(res, 200, {
    outcome: output.outcome,
    ...(wire ? { grant: wire } : {}),
    promise: revokePromiseCopy(
      enforcementLocus(grant?.audience.kind === "circle" ? "circle" : "person")
    ),
    message:
      (wire?.reason as string | undefined) ??
      "no longer shared; nothing had been delivered",
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

    if (url.pathname === SUBJECTS_PATH) {
      if (method !== "GET")
        return sendJson(res, 405, { error: "method_not_allowed" });
      return sendJson(res, 200, { subjects: subjectsWire(), loci: lociWire() });
    }

    const vault = deps.currentVault();
    if (!vault)
      return sendJson(res, 409, {
        error: "vault_unavailable",
        message: "no vault is mounted for this request",
      });
    if (deps.enrollments.owners.ownerOf(vault.vaultId) !== owner.ownerId)
      return sendJson(res, 404, { error: "not_found" });

    if (url.pathname === GRANTS_PATH) {
      if (method === "GET") return listGrants(res, vault, url);
      if (method === "POST") return createGrant(req, res, vault);
      return sendJson(res, 405, { error: "method_not_allowed" });
    }

    const rest = url.pathname.slice(`${GRANTS_PATH}/`.length).split("/");
    const grantId = decodeURIComponent(rest[0] ?? "");
    if (!grantId) return sendJson(res, 404, { error: "not_found" });
    if (rest.length === 2 && rest[1] === "revoke") {
      if (method !== "POST")
        return sendJson(res, 405, { error: "method_not_allowed" });
      return revokeGrant(res, vault, grantId);
    }
    if (rest.length !== 1) return sendJson(res, 404, { error: "not_found" });
    if (method !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" });
    const grant = readShareGrant(vault.db.vault, grantId);
    if (!grant) return sendJson(res, 404, { error: "not_found" });
    return sendJson(res, 200, { grant: grantWire(vault.db, grant) });
  };
}
