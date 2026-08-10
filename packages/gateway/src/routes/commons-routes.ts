// governance: allow-repo-hygiene file-size-limit (#731) the Commons route owns invitation, claim, accept, command, resident-save, and reconciliation doors under one authenticated vault boundary.
/** Owner/member control surface for circle-backed Commons (#731). */

import type { IncomingMessage } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import {
  answerCommonsInvitation,
  commonsSeats,
  commonsCurrentSize,
  compileCommons,
  createCommonsClaimInvitation,
  claimCommonsInvitation,
  ensureCommonsGrant,
  executeCommonsCommand,
  isShareableItemType,
  listCommonsInvitations,
  listCommonsGrants,
  readCommonsGrant,
  recompileCommonsGrants,
  refuseCommonsMember,
  removeCommonsMember,
  revokeCommonsGrant,
  retainCommonsItem,
  queueCommonsIntent,
  queueCommonsInvitation,
  settleCommonsIntent,
  scrubCommonsSeat,
  signCommonsIntent,
  transferCommonsSteward,
  upsertCommonsMember,
  uuidv7,
} from "@centraid/vault";
import type {
  CommonsCapability,
  CommonsMemberInput,
  ExecuteCommonsCommandInput,
  ShareableItemType,
} from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import { readJson, sendJson } from "./route-helpers.js";

export const COMMONS_PATH = "/centraid/_gateway/commons";
const COMMONS_CONTAINER_TYPES = new Set<ShareableItemType>([
  "core.collection",
  "core.content_item",
  "core.document",
  "docs.folder",
  "media.media_asset",
  "tally.group",
]);

export function isCommonsContainerType(
  value: string
): value is ShareableItemType {
  return COMMONS_CONTAINER_TYPES.has(value as ShareableItemType);
}

export interface CommonsRouteDeps {
  enrollments: EnrollmentStore;
  vaultFor: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["steward"] | undefined;
  ownerPartyFor: (vaultId: string) => string | undefined;
  gatewayFor: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["gateway"] | undefined;
  credentialFor: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["credential"] | undefined;
  linkedVaultPublicKey?: (
    localVaultId: string,
    peerVaultId: string
  ) => string | undefined;
  vaultPublicKeyFor?: (vaultId: string) => string | undefined;
  invitePeer?: (input: {
    stewardVaultId: string;
    memberVaultId: string;
    grantId: string;
    memberPartyId: string;
    capability: CommonsCapability;
    containerType: string;
    containerId: string;
    containerLabel?: string;
    currentSizeBytes: number;
    maxSizeBytes?: number;
  }) => Promise<boolean>;
  acceptPeer?: (input: {
    stewardVaultId: string;
    memberVaultId: string;
    grantId: string;
    expectedSizeBytes: number;
  }) => Promise<boolean>;
  claimPeer?: (input: {
    stewardVaultId: string;
    memberVaultId: string;
    claimToken: string;
  }) => Promise<boolean>;
  refusePeer?: (input: {
    stewardVaultId: string;
    memberVaultId: string;
    grantId: string;
  }) => Promise<boolean>;
}

interface MemberBody {
  partyId?: string;
  vaultId?: string;
  capability: CommonsCapability;
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function callerOwner(req: IncomingMessage, deps: CommonsRouteDeps) {
  const deviceId = callerDeviceId(req);
  return deviceId ? deps.enrollments.ownerFor(deviceId) : undefined;
}

function membersOf(
  raw: unknown,
  deps: CommonsRouteDeps,
  originVaultId: string
): CommonsMemberInput[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error("members must be a non-empty array");
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object")
      throw new Error(`members[${index}] must be an object`);
    const member = entry as Partial<MemberBody>;
    const partyId =
      member.partyId ??
      (member.vaultId ? deps.ownerPartyFor(member.vaultId) : undefined);
    if (!partyId)
      throw new Error(`members[${index}] needs a partyId or a joined vault`);
    if (member.capability !== "read" && member.capability !== "read+write")
      throw new Error(
        `members[${index}].capability must be read or read+write`
      );
    const localVault = member.vaultId
      ? deps.vaultFor(member.vaultId)
      : undefined;
    const remotePublicKey =
      member.vaultId && !localVault
        ? deps.linkedVaultPublicKey?.(originVaultId, member.vaultId)
        : undefined;
    return {
      partyId,
      capability: member.capability,
      ...(member.vaultId
        ? {
            vaultId: member.vaultId,
            ...(localVault ? { vault: localVault } : {}),
            ...(remotePublicKey ? { vaultPublicKey: remotePublicKey } : {}),
          }
        : {}),
    };
  });
}

function requireOrigin(
  raw: unknown,
  ownerId: string,
  deps: CommonsRouteDeps
): {
  vaultId: string;
  vault: ExecuteCommonsCommandInput["steward"];
  ownerPartyId: string;
} {
  const vaultId = typeof raw === "string" ? raw : "";
  if (deps.enrollments.owners.ownerOf(vaultId) !== ownerId)
    throw new Error("origin vault is not owned by this caller");
  const vault = deps.vaultFor(vaultId);
  const ownerPartyId = deps.ownerPartyFor(vaultId);
  if (!vault || !ownerPartyId) throw new Error("origin vault is not mounted");
  return { vaultId, vault, ownerPartyId };
}

function compileAll(
  origin: {
    vaultId: string;
    vault: ExecuteCommonsCommandInput["steward"];
    ownerPartyId: string;
  },
  deps: CommonsRouteDeps,
  now: string
) {
  return recompileCommonsGrants({
    steward: origin.vault,
    stewardVaultId: origin.vaultId,
    stewardPartyId: origin.ownerPartyId,
    vaultFor: deps.vaultFor,
    now,
  });
}

function routeParts(pathname: string): string[] | undefined {
  if (pathname === COMMONS_PATH) return [];
  if (!pathname.startsWith(`${COMMONS_PATH}/`)) return undefined;
  return pathname.slice(COMMONS_PATH.length + 1).split("/");
}

export function makeCommonsRouteHandler(deps: CommonsRouteDeps): RouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const parts = routeParts(url.pathname);
    if (!parts) return false;
    const owner = callerOwner(req, deps);
    if (!owner)
      return sendJson(res, 403, { error: "device_identity_required" });
    try {
      if (parts.length === 0 && req.method === "GET") {
        const origin = requireOrigin(
          url.searchParams.get("originVaultId"),
          owner.ownerId,
          deps
        );
        return sendJson(res, 200, {
          grants: listCommonsGrants(origin.vault.vault),
        });
      }
      if (parts[0] === "intents" && req.method === "GET") {
        const actorVaultId = url.searchParams.get("actorVaultId") ?? "";
        if (deps.enrollments.owners.ownerOf(actorVaultId) !== owner.ownerId)
          throw new Error("actor vault is not owned by this caller");
        const actor = deps.vaultFor(actorVaultId);
        if (!actor) throw new Error("actor vault is not mounted");
        const intents = actor.vault
          .prepare(
            `SELECT intent_id AS intentId, grant_id AS grantId,
                    actor_party_id AS actorPartyId, command,
                    input_json AS inputJson, status, reason,
                    steward_label AS stewardLabel,
                    created_at AS createdAt, settled_at AS settledAt
               FROM share_commons_intent
              ORDER BY created_at, intent_id`
          )
          .all();
        return sendJson(res, 200, { intents });
      }
      if (parts[0] === "invitations" && req.method === "GET") {
        const actorVaultId = url.searchParams.get("actorVaultId") ?? "";
        if (deps.enrollments.owners.ownerOf(actorVaultId) !== owner.ownerId)
          throw new Error("actor vault is not owned by this caller");
        const actor = deps.vaultFor(actorVaultId);
        if (!actor) throw new Error("actor vault is not mounted");
        return sendJson(res, 200, {
          invitations: listCommonsInvitations({
            seat: actor.vault,
            memberVaultId: actorVaultId,
          }),
        });
      }
      if (parts[0] === "resident" && req.method === "GET") {
        const actorVaultId = url.searchParams.get("actorVaultId") ?? "";
        if (deps.enrollments.owners.ownerOf(actorVaultId) !== owner.ownerId)
          throw new Error("actor vault is not owned by this caller");
        const actor = deps.vaultFor(actorVaultId);
        if (!actor) throw new Error("actor vault is not mounted");
        return sendJson(res, 200, {
          items: actor.vault
            .prepare(
              `SELECT l.grant_id AS grantId, l.item_type AS itemType,
                      l.item_id AS itemId, l.origin_item_id AS originItemId
                 FROM share_commons_lineage l
                 JOIN share_circle_grant g ON g.grant_id = l.grant_id
                 JOIN core_share_origin o
                   ON o.item_type = l.item_type AND o.item_id = l.item_id
                  AND o.shared_by = 'commons:' || l.grant_id
                WHERE g.revoked_at IS NULL
                ORDER BY l.grant_id, l.item_type, l.item_id`
            )
            .all(),
        });
      }

      const body = await readJson(req);
      if (parts[0] === "retain" && req.method === "POST") {
        const actorVaultId =
          typeof body.actorVaultId === "string" ? body.actorVaultId : "";
        if (deps.enrollments.owners.ownerOf(actorVaultId) !== owner.ownerId)
          throw new Error("actor vault is not owned by this caller");
        const actor = deps.vaultFor(actorVaultId);
        if (!actor) throw new Error("actor vault is not mounted");
        if (
          typeof body.itemType !== "string" ||
          !isShareableItemType(body.itemType) ||
          typeof body.itemId !== "string" ||
          !body.itemId
        )
          throw new Error("itemType and itemId must name a resident item");
        return sendJson(
          res,
          200,
          retainCommonsItem({
            seat: actor.vault,
            itemType: body.itemType,
            itemId: body.itemId,
            now: new Date().toISOString(),
          })
        );
      }
      if (
        parts[0] === "invitations" &&
        parts[1] === "claim" &&
        req.method === "POST"
      ) {
        const actorVaultId =
          typeof body.actorVaultId === "string" ? body.actorVaultId : "";
        const stewardVaultId =
          typeof body.stewardVaultId === "string" ? body.stewardVaultId : "";
        const claimToken =
          typeof body.claimToken === "string" ? body.claimToken : "";
        if (deps.enrollments.owners.ownerOf(actorVaultId) !== owner.ownerId)
          throw new Error("actor vault is not owned by this caller");
        const actor = deps.vaultFor(actorVaultId);
        const publicKey = deps.vaultPublicKeyFor?.(actorVaultId);
        if (!actor || !publicKey || !claimToken)
          throw new Error("claiming vault identity is unavailable");
        const steward = deps.vaultFor(stewardVaultId);
        if (steward) {
          const linkedKey = deps.linkedVaultPublicKey?.(
            stewardVaultId,
            actorVaultId
          );
          if (!linkedKey || linkedKey !== publicKey)
            throw new Error(
              "commons invitation claim requires an approved vault link"
            );
          const invitation = claimCommonsInvitation({
            steward: steward.vault,
            claimToken,
            memberVaultId: actorVaultId,
            memberVaultPublicKey: publicKey,
            now: new Date().toISOString(),
          });
          queueCommonsInvitation({
            seat: actor.vault,
            invitation: {
              ...invitation,
              memberVaultId: actorVaultId,
            },
            now: new Date().toISOString(),
          });
        } else if (
          !deps.claimPeer ||
          !(await deps.claimPeer({
            stewardVaultId,
            memberVaultId: actorVaultId,
            claimToken,
          }))
        ) {
          throw new Error(
            "commons invitation claim could not reach its steward"
          );
        }
        return sendJson(res, 200, { claimed: true });
      }
      if (
        parts[0] === "invitations" &&
        parts[1] &&
        parts[2] === "answer" &&
        req.method === "POST"
      ) {
        const actorVaultId =
          typeof body.actorVaultId === "string" ? body.actorVaultId : "";
        if (deps.enrollments.owners.ownerOf(actorVaultId) !== owner.ownerId)
          throw new Error("actor vault is not owned by this caller");
        const actor = deps.vaultFor(actorVaultId);
        if (!actor) throw new Error("actor vault is not mounted");
        if (body.answer !== "accept" && body.answer !== "refuse")
          throw new Error("answer must be accept or refuse");
        const invitationId = decodeURIComponent(parts[1]);
        const held = listCommonsInvitations({
          seat: actor.vault,
          memberVaultId: actorVaultId,
        }).find((entry) => entry.invitationId === invitationId);
        if (!held)
          throw new Error("commons invitation is not available for this vault");
        const now = new Date().toISOString();
        if (body.answer === "refuse" && held.status === "pending") {
          const steward = deps.vaultFor(held.stewardVaultId);
          if (steward) {
            const binding = steward.vault
              .prepare(
                `SELECT 1 AS n FROM share_party_vault_binding
                  WHERE party_id = ? AND vault_id = ? AND revoked_at IS NULL`
              )
              .get(held.memberPartyId, actorVaultId);
            if (
              !binding &&
              deps.ownerPartyFor(actorVaultId) !== held.memberPartyId
            )
              throw new Error(
                "commons invitation identity is not bound at its steward"
              );
            refuseCommonsMember({
              steward: steward.vault,
              grantId: held.grantId,
              memberPartyId: held.memberPartyId,
              now,
            });
          } else if (
            !deps.refusePeer ||
            !(await deps.refusePeer({
              stewardVaultId: held.stewardVaultId,
              memberVaultId: actorVaultId,
              grantId: held.grantId,
            }))
          ) {
            throw new Error(
              "commons steward is unavailable; invitation remains pending"
            );
          }
        }
        if (body.answer === "accept" && held.status === "pending") {
          const steward = deps.vaultFor(held.stewardVaultId);
          const stewardPartyId = deps.ownerPartyFor(held.stewardVaultId);
          if (steward && stewardPartyId) {
            const freshGrant = readCommonsGrant(steward.vault, held.grantId);
            const freshSize = commonsCurrentSize(
              steward.vault,
              held.stewardVaultId,
              held.grantId
            );
            if (
              freshSize !== held.currentSizeBytes ||
              (freshGrant.maxSizeBytes !== undefined &&
                freshSize > freshGrant.maxSizeBytes)
            ) {
              actor.vault
                .prepare(
                  `UPDATE share_commons_invitation
                      SET current_size_bytes = ?, max_size_bytes = ?
                    WHERE invitation_id = ? AND status = 'pending'`
                )
                .run(freshSize, freshGrant.maxSizeBytes ?? null, invitationId);
              throw new Error(
                `commons size changed from ${held.currentSizeBytes} to ${freshSize} bytes; review the invitation again`
              );
            }
            upsertCommonsMember({
              steward: steward.vault,
              grantId: held.grantId,
              actorPartyId: stewardPartyId,
              member: {
                partyId: held.memberPartyId,
                capability: held.capability,
                vaultId: actorVaultId,
                vault: actor,
              },
              now,
            });
            recompileCommonsGrants({
              steward,
              stewardVaultId: held.stewardVaultId,
              stewardPartyId,
              grantId: held.grantId,
              vaultFor: deps.vaultFor,
              now,
            });
          } else if (
            !deps.acceptPeer ||
            !(await deps.acceptPeer({
              stewardVaultId: held.stewardVaultId,
              memberVaultId: actorVaultId,
              grantId: held.grantId,
              expectedSizeBytes: held.currentSizeBytes,
            }))
          ) {
            throw new Error(
              "commons steward is unavailable; invitation remains pending"
            );
          }
        }
        return sendJson(res, 200, {
          invitation: answerCommonsInvitation({
            seat: actor,
            invitationId,
            memberVaultId: actorVaultId,
            answer: body.answer,
            now,
          }),
        });
      }
      if (parts.length === 0 && req.method === "POST") {
        const origin = requireOrigin(body.originVaultId, owner.ownerId, deps);
        const containerType = body.containerType;
        const containerId = body.containerId;
        if (
          typeof containerType !== "string" ||
          !isCommonsContainerType(containerType) ||
          typeof containerId !== "string" ||
          !containerId
        )
          throw new Error(
            "containerType and containerId must name a shareable container"
          );
        const members = membersOf(body.members, deps, origin.vaultId);
        const now = new Date().toISOString();
        const { grant } = ensureCommonsGrant({
          origin: origin.vault.vault,
          ownerPartyId: origin.ownerPartyId,
          ownerVaultId: origin.vaultId,
          ownerVault: origin.vault,
          ...(typeof body.circleId === "string"
            ? { circleId: body.circleId }
            : {}),
          ...(typeof body.circleName === "string"
            ? { circleName: body.circleName }
            : {}),
          containerType,
          containerId,
          // ShareSheet creates invitations. A vault id is an address and a
          // party binding is identity; neither is receiver consent.
          members: members.map(({ partyId, capability, displayName }) => ({
            partyId,
            capability,
            ...(displayName ? { displayName } : {}),
          })),
          ...(typeof body.maxSizeBytes === "number"
            ? { maxSizeBytes: body.maxSizeBytes }
            : {}),
          now,
        });
        const seats = compileCommons({
          steward: origin.vault,
          stewardVaultId: origin.vaultId,
          grantId: grant.grantId,
          seats: commonsSeats({
            steward: origin.vault.vault,
            grantId: grant.grantId,
            stewardVaultId: origin.vaultId,
            vaultFor: deps.vaultFor,
          }),
          now,
        });
        const currentSizeBytes = commonsCurrentSize(
          origin.vault.vault,
          origin.vaultId,
          grant.grantId
        );
        const claims: { partyId: string; claimToken: string }[] = [];
        for (const member of members) {
          const invitationBase = {
            grantId: grant.grantId,
            stewardVaultId: origin.vaultId,
            memberPartyId: member.partyId,
            capability: member.capability,
            containerType,
            containerId,
            ...(typeof body.circleName === "string"
              ? { containerLabel: body.circleName }
              : {}),
            currentSizeBytes,
            ...(grant.maxSizeBytes === undefined
              ? {}
              : { maxSizeBytes: grant.maxSizeBytes }),
          };
          if (!member.vaultId) {
            const claimed = createCommonsClaimInvitation({
              seat: origin.vault.vault,
              invitation: invitationBase,
              now,
            });
            claims.push({
              partyId: member.partyId,
              claimToken: claimed.claimToken,
            });
            continue;
          }
          const invitation = {
            ...invitationBase,
            memberVaultId: member.vaultId,
          };
          if (member.vault)
            queueCommonsInvitation({
              seat: member.vault.vault,
              invitation,
              now,
            });
          else if (deps.invitePeer)
            // oxlint-disable-next-line no-await-in-loop -- preserve roster order and stop before later invitations when a peer delivery fails
            await deps.invitePeer({
              ...invitation,
            });
        }
        const view = listCommonsGrants(origin.vault.vault).find(
          (entry) => entry.grant.grantId === grant.grantId
        );
        const state = view?.members.some(
          (member) => member.status === "invited"
        )
          ? "invited"
          : "active";
        return sendJson(res, 201, {
          grantId: grant.grantId,
          circleId: grant.circleId,
          state,
          grant: readCommonsGrant(origin.vault.vault, grant.grantId),
          seats,
          members: view?.members ?? [],
          currentSizeBytes,
          maxSizeBytes: grant.maxSizeBytes ?? null,
          claims,
        });
      }

      const grantId = parts[0];
      if (!grantId) return sendJson(res, 404, { error: "not_found" });

      if (parts[1] === "commands" && req.method === "POST") {
        const originVaultId =
          typeof body.originVaultId === "string" ? body.originVaultId : "";
        const actorVaultId =
          typeof body.actorVaultId === "string" ? body.actorVaultId : "";
        if (deps.enrollments.owners.ownerOf(actorVaultId) !== owner.ownerId)
          throw new Error("actor vault is not owned by this caller");
        const actor = deps.vaultFor(actorVaultId);
        const actorPartyId = actor
          ? ((
              actor.vault
                .prepare(
                  `SELECT b.party_id FROM share_party_vault_binding b
                 JOIN social_circle_member m ON m.party_id = b.party_id
                 JOIN share_circle_grant g ON g.circle_id = m.circle_id
                 JOIN share_commons_member_state s
                   ON s.grant_id = g.grant_id AND s.party_id = b.party_id
                  AND s.status = 'current'
                 WHERE g.grant_id = ? AND b.vault_id = ?
                   AND b.revoked_at IS NULL LIMIT 1`
                )
                .get(grantId, actorVaultId) as { party_id: string } | undefined
            )?.party_id ?? deps.ownerPartyFor(actorVaultId))
          : undefined;
        if (!actor || !actorPartyId)
          throw new Error("commons actor vault is not mounted");
        if (
          typeof body.command !== "string" ||
          !body.input ||
          typeof body.input !== "object"
        )
          throw new Error("command and input are required");
        const intentId =
          typeof body.intentId === "string" ? body.intentId : uuidv7();
        queueCommonsIntent({
          seat: actor.vault,
          intentId,
          grantId,
          actorPartyId,
          command: body.command,
          commandInput: body.input,
          stewardLabel:
            typeof body.stewardLabel === "string"
              ? body.stewardLabel
              : originVaultId,
          now: new Date().toISOString(),
        });
        const steward = deps.vaultFor(originVaultId);
        const gateway = deps.gatewayFor(originVaultId);
        const credential = deps.credentialFor(originVaultId);
        if (!steward || !gateway || !credential) {
          const reason = `waiting for ${
            typeof body.stewardLabel === "string"
              ? body.stewardLabel
              : "the steward's device"
          }`;
          settleCommonsIntent({
            seat: actor.vault,
            intentId,
            status: "parked",
            reason,
            now: new Date().toISOString(),
          });
          return sendJson(res, 202, {
            queued: true,
            intentId,
            status: "parked",
            reason,
          });
        }
        const grant = readCommonsGrant(steward.vault, grantId);
        const memberSignature =
          actorPartyId === grant.stewardPartyId
            ? undefined
            : signCommonsIntent(actor.identitySeed, {
                grantId,
                actorPartyId,
                command: body.command,
                commandInput: body.input,
                memberVaultId: actorVaultId,
                nonce: intentId,
              });
        const now = new Date().toISOString();
        const result = executeCommonsCommand({
          steward,
          gateway,
          credential,
          stewardVaultId: originVaultId,
          grantId,
          actorPartyId,
          command: body.command,
          commandInput: body.input as Record<string, unknown>,
          seats: commonsSeats({
            steward: steward.vault,
            grantId,
            stewardVaultId: originVaultId,
            vaultFor: deps.vaultFor,
          }),
          ...(memberSignature ? { memberSignature } : {}),
          intentId,
          invocationId: intentId,
          now,
        });
        const stewardPartyId = deps.ownerPartyFor(originVaultId);
        if (result.decision.accepted && stewardPartyId)
          compileAll(
            {
              vaultId: originVaultId,
              vault: steward,
              ownerPartyId: stewardPartyId,
            },
            deps,
            now
          );
        if (!result.decision.accepted)
          settleCommonsIntent({
            seat: actor.vault,
            intentId,
            status: "denied",
            reason: result.decision.reason,
            now,
          });
        return sendJson(res, result.decision.accepted ? 200 : 403, result);
      }

      const origin = requireOrigin(body.originVaultId, owner.ownerId, deps);
      const now = new Date().toISOString();
      if (parts[1] === "steward-transfer" && req.method === "POST") {
        const seats = commonsSeats({
          steward: origin.vault.vault,
          grantId,
          stewardVaultId: origin.vaultId,
          vaultFor: deps.vaultFor,
        });
        const successorPartyId = transferCommonsSteward({
          steward: origin.vault.vault,
          grantId,
          actorPartyId: origin.ownerPartyId,
          ...(typeof body.successorPartyId === "string"
            ? { successorPartyId: body.successorPartyId }
            : {}),
          now,
        });
        const compiled = compileCommons({
          steward: origin.vault,
          stewardVaultId: origin.vaultId,
          grantId,
          seats,
          now,
        });
        return sendJson(res, 200, { successorPartyId, compiled });
      }
      if (parts.length === 1 && req.method === "DELETE") {
        const before = listCommonsGrants(origin.vault.vault).find(
          (entry) => entry.grant.grantId === grantId
        );
        revokeCommonsGrant({
          steward: origin.vault.vault,
          grantId,
          actorPartyId: origin.ownerPartyId,
          now,
        });
        for (const member of before?.members ?? []) {
          if (member.partyId === origin.ownerPartyId) continue;
          scrubCommonsSeat({
            seat: member.vaultId ? deps.vaultFor(member.vaultId) : undefined,
            grantId,
          });
        }
        return sendJson(res, 200, { revoked: true });
      }

      if (parts[1] === "members" && parts[2]) {
        const memberPartyId = decodeURIComponent(parts[2]);
        const before = listCommonsGrants(origin.vault.vault).find(
          (entry) => entry.grant.grantId === grantId
        );
        if (req.method === "DELETE") {
          const removed = before?.members.find(
            (member) => member.partyId === memberPartyId
          );
          removeCommonsMember({
            steward: origin.vault.vault,
            grantId,
            actorPartyId: origin.ownerPartyId,
            memberPartyId,
            now,
          });
          scrubCommonsSeat({
            seat: removed?.vaultId ? deps.vaultFor(removed.vaultId) : undefined,
            grantId,
          });
          return sendJson(res, 200, {
            sequence: readCommonsGrant(origin.vault.vault, grantId)
              .lastSequence,
            compiled: compileAll(origin, deps, now),
          });
        }
        if (req.method === "PATCH") {
          if (body.capability !== "read" && body.capability !== "read+write")
            throw new Error("capability must be read or read+write");
          const vaultId =
            typeof body.vaultId === "string" ? body.vaultId : undefined;
          const sequence = upsertCommonsMember({
            steward: origin.vault.vault,
            grantId,
            actorPartyId: origin.ownerPartyId,
            member: {
              partyId: memberPartyId,
              capability: body.capability,
              ...(vaultId ? { vaultId, vault: deps.vaultFor(vaultId) } : {}),
            },
            now,
          });
          return sendJson(res, 200, {
            sequence,
            compiled: compileAll(origin, deps, now),
          });
        }
      }

      return sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      return sendJson(res, 400, {
        error: "invalid_commons",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
