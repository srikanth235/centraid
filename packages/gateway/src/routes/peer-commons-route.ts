/** Peer-plane snapshot/tail, CAS pull, and signed command doors for Commons. */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  acknowledgeCommonsSeatCursor,
  compactCommonsOperations,
  commonsCurrentSize,
  commonsSeats,
  claimCommonsInvitation,
  executeCommonsCommand,
  exportCommonsSyncFrame,
  queueCommonsInvitation,
  readCommonsChainHead,
  readCommonsGrant,
  refuseCommonsMember,
  upsertCommonsMember,
} from "@centraid/vault";
import type {
  CommonsBootstrap,
  CommonsMemberSignature,
  ExecuteCommonsCommandInput,
} from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import {
  beginCommonsBootstrapPages,
  resumeCommonsBootstrapPages,
} from "./peer-commons-pages.js";
import type { PeerIdentity } from "./peer-plane.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PEER_COMMONS_BOOTSTRAP_PATH_PREFIX =
  "/centraid/_peer/commons/bootstrap/";
export const PEER_COMMONS_BLOB_PATH = "/centraid/_peer/commons/blob/chunk";
export const PEER_COMMONS_COMMAND_PATH = "/centraid/_peer/commons/command";
export const PEER_COMMONS_INVITE_PATH = "/centraid/_peer/commons/invite";
export const PEER_COMMONS_CLAIM_PATH = "/centraid/_peer/commons/claim";
export const PEER_COMMONS_REFUSE_PATH = "/centraid/_peer/commons/refuse";

export interface PeerCommonsRouteDeps {
  vaultFor: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["steward"] | undefined;
  gatewayFor: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["gateway"] | undefined;
  credentialFor: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["credential"] | undefined;
  gatewayDatabase?: GatewayDatabase;
  /** Observability seam: one event per fresh signed export, never per page/blob. */
  onBootstrapExport?: (grantId: string) => void;
}

const COMMONS_BLOB_ACCESS_TTL_MS = 5 * 60 * 1000;

function authorizeFrameBlobs(
  gatewayDatabase: GatewayDatabase | undefined,
  wire: CommonsBootstrap
): void {
  if (!gatewayDatabase) return;
  const now = Date.now();
  gatewayDatabase.db
    .prepare("DELETE FROM commons_blob_access WHERE expires_at <= ?")
    .run(now);
  const insert = gatewayDatabase.db.prepare(
    `INSERT INTO commons_blob_access
       (grant_id, member_vault_id, sha256, size, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(grant_id, member_vault_id, sha256) DO UPDATE SET
       size = excluded.size, expires_at = excluded.expires_at`
  );
  for (const blob of wire.closure.blobs)
    insert.run(
      wire.grantId,
      wire.memberVaultId,
      blob.sha256,
      blob.size,
      now + COMMONS_BLOB_ACCESS_TTL_MS
    );
}

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { state: "not_found" });
}

function pair(
  peer: PeerIdentity,
  query: URLSearchParams
):
  | {
      stewardVaultId: string;
      memberVaultId: string;
      link: NonNullable<ReturnType<PeerIdentity["linkForPair"]>>;
    }
  | undefined {
  const stewardVaultId = query.get("stewardVaultId") ?? "";
  const memberVaultId = query.get("memberVaultId") ?? "";
  const link =
    stewardVaultId && memberVaultId
      ? peer.linkForPair(stewardVaultId, memberVaultId)
      : undefined;
  return link ? { stewardVaultId, memberVaultId, link } : undefined;
}

function uint(raw: string | null): number | undefined {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function handlePeerCommonsBootstrap(
  res: ServerResponse,
  peer: PeerIdentity,
  grantId: string,
  query: URLSearchParams,
  deps: PeerCommonsRouteDeps
): true {
  const linked = pair(peer, query);
  const steward = linked ? deps.vaultFor(linked.stewardVaultId) : undefined;
  if (!linked || !steward) return notFound(res);
  try {
    const frameId = query.get("frameId");
    const pageCursor = uint(query.get("pageCursor"));
    if (frameId && pageCursor !== undefined)
      return resumeCommonsBootstrapPages({
        res,
        frameId,
        cursor: pageCursor,
        grantId,
        memberVaultId: linked.memberVaultId,
        stewardVaultId: linked.stewardVaultId,
      });
    if (query.get("inspect") === "1") {
      const grant = readCommonsGrant(steward.vault, grantId);
      const claimed = steward.vault
        .prepare(
          `SELECT b.party_id FROM share_party_vault_binding b
           JOIN social_circle_member m ON m.party_id = b.party_id
           JOIN share_commons_member_state s
             ON s.grant_id = ? AND s.party_id = b.party_id
           WHERE b.vault_id = ? AND b.revoked_at IS NULL
             AND m.circle_id = ? LIMIT 1`
        )
        .get(grantId, linked.memberVaultId, grant.circleId);
      if (!claimed) return notFound(res);
      return sendJson(res, 200, {
        state: "metadata",
        currentSizeBytes: commonsCurrentSize(
          steward.vault,
          linked.stewardVaultId,
          grantId
        ),
        maxSizeBytes: grant.maxSizeBytes ?? null,
      });
    }
    if (query.get("accept") === "1") {
      const grant = readCommonsGrant(steward.vault, grantId);
      const claimed = steward.vault
        .prepare(
          `SELECT b.party_id FROM share_party_vault_binding b
           JOIN social_circle_member m ON m.party_id = b.party_id
           JOIN share_commons_member_state s
             ON s.grant_id = ? AND s.party_id = b.party_id
           WHERE b.vault_id = ? AND b.revoked_at IS NULL
             AND m.circle_id = ? LIMIT 1`
        )
        .get(grantId, linked.memberVaultId, grant.circleId) as
        | { party_id: string }
        | undefined;
      const memberPartyId = claimed?.party_id ?? linked.link.peerPartyId;
      const member = memberPartyId
        ? (steward.vault
            .prepare(
              `SELECT capability FROM social_circle_member
                WHERE circle_id = ? AND party_id = ?`
            )
            .get(grant.circleId, memberPartyId) as
            | { capability: "read" | "read+write" }
            | undefined)
        : undefined;
      if (!memberPartyId || !member) return notFound(res);
      upsertCommonsMember({
        steward: steward.vault,
        grantId,
        actorPartyId: grant.stewardPartyId,
        member: {
          partyId: memberPartyId,
          capability: member.capability,
          vaultId: linked.memberVaultId,
          vaultPublicKey: linked.link.peerPublicKey,
        },
        now: new Date().toISOString(),
      });
    }
    const frame = exportCommonsSyncFrame({
      steward: steward.vault,
      identitySeed: steward.identitySeed,
      stewardVaultId: linked.stewardVaultId,
      grantId,
      memberVaultId: linked.memberVaultId,
      incremental: query.get("incremental") === "1",
    });
    deps.onBootstrapExport?.(grantId);
    const acknowledged = uint(query.get("afterSequence"));
    const currentSequence =
      frame.state === "bootstrap"
        ? frame.wire.currentSequence
        : frame.tombstone.currentSequence;
    if (acknowledged !== undefined && acknowledged <= currentSequence) {
      acknowledgeCommonsSeatCursor({
        steward: steward.vault,
        grantId,
        memberVaultId: linked.memberVaultId,
        sequence: acknowledged,
        now: new Date().toISOString(),
      });
      compactCommonsOperations(steward.vault, grantId);
    }
    // A fully caught-up member (its ack equals the grant's head) needs no data:
    // shipping a full bootstrap frame here would make the client scrub and
    // re-project the whole commons — deleting its seat-local OCR/embeddings/FTS
    // and re-enqueuing enrichment — and count as sweep progress, pinning the
    // active cadence. Answer an explicit no-op instead (the ack + compaction
    // above already ran). Tombstones are never short-circuited: a removed
    // member still needs the scrub they carry.
    if (
      frame.state === "bootstrap" &&
      acknowledged !== undefined &&
      acknowledged === currentSequence
    )
      return sendJson(res, 200, {
        state: "current",
        grantId,
        currentSequence,
        // The no-op still carries the chain head (#731): a steward that forked
        // at a sequence the member already verified would otherwise hide
        // behind "you are caught up".
        headHash: readCommonsChainHead(steward.vault, grantId).hash,
      });
    if (frame.state === "bootstrap") {
      authorizeFrameBlobs(deps.gatewayDatabase, frame.wire);
      return beginCommonsBootstrapPages({ res, wire: frame.wire });
    }
    return sendJson(res, 200, frame);
  } catch {
    return notFound(res);
  }
}

export function handlePeerCommonsBlob(
  res: ServerResponse,
  peer: PeerIdentity,
  query: URLSearchParams,
  deps: PeerCommonsRouteDeps
): true {
  const linked = pair(peer, query);
  const grantId = query.get("grantId") ?? "";
  const sha256 = query.get("sha256") ?? "";
  const offset = uint(query.get("offset"));
  const length = uint(query.get("length"));
  const steward = linked ? deps.vaultFor(linked.stewardVaultId) : undefined;
  if (
    !linked ||
    !steward ||
    !deps.gatewayDatabase ||
    !grantId ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    offset === undefined ||
    length === undefined ||
    length === 0
  )
    return notFound(res);
  try {
    const now = Date.now();
    deps.gatewayDatabase.db
      .prepare("DELETE FROM commons_blob_access WHERE expires_at <= ?")
      .run(now);
    const access = deps.gatewayDatabase.db
      .prepare(
        `SELECT size FROM commons_blob_access
          WHERE grant_id = ? AND member_vault_id = ? AND sha256 = ?
            AND expires_at > ?`
      )
      .get(grantId, linked.memberVaultId, sha256, now) as
      | { size: number }
      | undefined;
    if (!access) return notFound(res);
    const stat = steward.blobs.local.statSync(sha256);
    if (!stat || stat.size !== access.size || offset > stat.size)
      return notFound(res);
    const end = Math.min(offset + length, stat.size) - 1;
    const bytes =
      offset >= stat.size
        ? Buffer.alloc(0)
        : steward.blobs.local.getSync(sha256, { start: offset, end });
    if (!bytes) return notFound(res);
    return sendJson(res, 200, {
      state: "chunk",
      sha256,
      offset,
      length: bytes.length,
      totalSize: stat.size,
      bytes: bytes.toString("base64"),
    });
  } catch {
    return notFound(res);
  }
}

export async function handlePeerCommonsCommand(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerCommonsRouteDeps
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const stewardVaultId =
    typeof body.stewardVaultId === "string" ? body.stewardVaultId : "";
  const memberVaultId =
    typeof body.memberVaultId === "string" ? body.memberVaultId : "";
  const grantId = typeof body.grantId === "string" ? body.grantId : "";
  const actorPartyId =
    typeof body.actorPartyId === "string" ? body.actorPartyId : "";
  const command = typeof body.command === "string" ? body.command : "";
  const memberSignature = body.memberSignature as
    | CommonsMemberSignature
    | undefined;
  const steward = deps.vaultFor(stewardVaultId);
  const gateway = deps.gatewayFor(stewardVaultId);
  const credential = deps.credentialFor(stewardVaultId);
  const link = peer.linkForPair(stewardVaultId, memberVaultId);
  // The grant sequence the member had projected locally when it composed this
  // command (issue #731 goal 1). It is member-supplied, untrusted input like
  // every other field on this wire body — it never rode inside the signed
  // intent bytes `memberSignature` covers — so it is an honesty/classification
  // signal for the stale-context check only, and must never widen what
  // `executeCommonsCommand` authorizes. v0 requires it explicitly on the
  // wire: a payload missing (or malforming) it is refused outright, with no
  // defaulting and no compat branch for pre-#731 senders.
  const basedOnSequence = body.basedOnSequence;
  if (
    !link ||
    !steward ||
    !gateway ||
    !credential ||
    !grantId ||
    !actorPartyId ||
    !command ||
    !body.input ||
    typeof body.input !== "object" ||
    !memberSignature ||
    memberSignature.memberVaultId !== memberVaultId ||
    typeof basedOnSequence !== "number" ||
    !Number.isInteger(basedOnSequence) ||
    basedOnSequence < 0
  )
    return notFound(res);
  // Bind the acted-as party to the PROVEN peer vault, exactly as the refuse
  // route does. `body.actorPartyId` is caller-supplied; a linked member — even
  // a read-only one — must never be able to claim to be the steward and forge
  // steward-attributed writes past capability/signature/replay (those all skip
  // when actorPartyId === stewardPartyId). Resolve the caller's real party from
  // the link's pinned key + circle membership and require the request to match.
  try {
    const grant = readCommonsGrant(steward.vault, grantId);
    const boundParty = steward.vault
      .prepare(
        `SELECT b.party_id FROM share_party_vault_binding b
         JOIN social_circle_member m
           ON m.circle_id = ? AND m.party_id = b.party_id
         WHERE b.vault_id = ? AND b.revoked_at IS NULL
           AND b.vault_public_key = ? LIMIT 1`
      )
      .get(grant.circleId, memberVaultId, link.peerPublicKey) as
      | { party_id: string }
      | undefined;
    if (!boundParty || boundParty.party_id !== actorPartyId)
      return notFound(res);
  } catch {
    return notFound(res);
  }
  const now = new Date().toISOString();
  const result = executeCommonsCommand({
    steward,
    gateway,
    credential,
    stewardVaultId,
    grantId,
    actorPartyId,
    command,
    commandInput: body.input as Record<string, unknown>,
    memberSignature,
    basedOnSequence,
    seats: commonsSeats({
      steward: steward.vault,
      grantId,
      stewardVaultId,
      vaultFor: deps.vaultFor,
      invokeFor: (vaultId, replicaCommand, commandInput, invocationId) => {
        const replicaGateway = deps.gatewayFor(vaultId);
        const replicaCredential = deps.credentialFor(vaultId);
        if (!replicaGateway || !replicaCredential)
          throw new Error(`commons replica vault ${vaultId} is not mounted`);
        return replicaGateway.invokeCommonsCanonical(
          replicaCredential,
          {
            command: replicaCommand,
            input: commandInput,
            purpose: "dpv:ServiceProvision",
            invocationId,
          },
          { idSeed: invocationId }
        );
      },
    }),
    ...(typeof body.intentId === "string"
      ? { intentId: body.intentId, invocationId: body.intentId }
      : {}),
    now,
  });
  return sendJson(res, result.decision.accepted ? 200 : 403, {
    state: result.decision.accepted ? "executed" : "refused",
    decision: result.decision,
  });
}

/** Steward-pushed invitation. The exact linked vault pair authenticates the
 * inviter, but the receiver gets only durable consent metadata until its
 * owner explicitly accepts through the local Commons route. */
export async function handlePeerCommonsInvite(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerCommonsRouteDeps
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const invitation = body.invitation as
    | {
        grantId?: unknown;
        stewardVaultId?: unknown;
        memberVaultId?: unknown;
        memberPartyId?: unknown;
        capability?: unknown;
        containerType?: unknown;
        containerId?: unknown;
        containerLabel?: unknown;
        currentSizeBytes?: unknown;
        maxSizeBytes?: unknown;
      }
    | undefined;
  if (
    !invitation ||
    typeof invitation.grantId !== "string" ||
    typeof invitation.stewardVaultId !== "string" ||
    typeof invitation.memberVaultId !== "string" ||
    typeof invitation.memberPartyId !== "string" ||
    (invitation.capability !== "read" &&
      invitation.capability !== "read+write") ||
    typeof invitation.containerType !== "string" ||
    typeof invitation.containerId !== "string" ||
    typeof invitation.currentSizeBytes !== "number" ||
    invitation.currentSizeBytes < 0 ||
    !peer.linkForPair(invitation.memberVaultId, invitation.stewardVaultId)
  )
    return notFound(res);
  const member = deps.vaultFor(invitation.memberVaultId);
  if (!member) return notFound(res);
  try {
    const pending = queueCommonsInvitation({
      seat: member.vault,
      invitation: {
        grantId: invitation.grantId,
        stewardVaultId: invitation.stewardVaultId,
        memberVaultId: invitation.memberVaultId,
        memberPartyId: invitation.memberPartyId,
        capability: invitation.capability,
        containerType: invitation.containerType,
        containerId: invitation.containerId,
        ...(typeof invitation.containerLabel === "string"
          ? { containerLabel: invitation.containerLabel }
          : {}),
        currentSizeBytes: invitation.currentSizeBytes,
        ...(typeof invitation.maxSizeBytes === "number"
          ? { maxSizeBytes: invitation.maxSizeBytes }
          : {}),
      },
      now: new Date().toISOString(),
    });
    return sendJson(res, 200, {
      state: "pending",
      invitationId: pending.invitationId,
      grantId: pending.grantId,
      currentSizeBytes: pending.currentSizeBytes,
    });
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
}

export async function handlePeerCommonsClaim(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerCommonsRouteDeps
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const stewardVaultId =
    typeof body.stewardVaultId === "string" ? body.stewardVaultId : "";
  const memberVaultId =
    typeof body.memberVaultId === "string" ? body.memberVaultId : "";
  const claimToken = typeof body.claimToken === "string" ? body.claimToken : "";
  const link = peer.linkForPair(stewardVaultId, memberVaultId);
  const steward = deps.vaultFor(stewardVaultId);
  if (!link || !steward || !claimToken) return notFound(res);
  try {
    const invitation = claimCommonsInvitation({
      steward: steward.vault,
      claimToken,
      memberVaultId,
      memberVaultPublicKey: link.peerPublicKey,
      now: new Date().toISOString(),
    });
    return sendJson(res, 200, { state: "pending", invitation });
  } catch {
    return notFound(res);
  }
}

/** Receiver consent refusal travels over the same authenticated vault pair as
 * claim/accept so the steward's control truth and ordered log stay honest. */
export async function handlePeerCommonsRefuse(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerCommonsRouteDeps
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const stewardVaultId =
    typeof body.stewardVaultId === "string" ? body.stewardVaultId : "";
  const memberVaultId =
    typeof body.memberVaultId === "string" ? body.memberVaultId : "";
  const grantId = typeof body.grantId === "string" ? body.grantId : "";
  const link = peer.linkForPair(stewardVaultId, memberVaultId);
  const steward = deps.vaultFor(stewardVaultId);
  if (!link || !steward || !grantId) return notFound(res);
  try {
    const grant = readCommonsGrant(steward.vault, grantId);
    const member = steward.vault
      .prepare(
        `SELECT b.party_id FROM share_party_vault_binding b
         JOIN social_circle_member m
           ON m.circle_id = ? AND m.party_id = b.party_id
         JOIN share_commons_member_state s
           ON s.grant_id = ? AND s.party_id = b.party_id
          AND s.status = 'invited'
         WHERE b.vault_id = ? AND b.revoked_at IS NULL
           AND b.vault_public_key = ? LIMIT 1`
      )
      .get(grant.circleId, grantId, memberVaultId, link.peerPublicKey) as
      | { party_id: string }
      | undefined;
    const memberPartyId =
      member?.party_id ??
      (link.peerPartyId &&
      steward.vault
        .prepare(
          `SELECT 1 AS n FROM social_circle_member m
           JOIN share_commons_member_state s
             ON s.grant_id = ? AND s.party_id = m.party_id
            AND s.status = 'invited'
           WHERE m.circle_id = ? AND m.party_id = ?`
        )
        .get(grantId, grant.circleId, link.peerPartyId)
        ? link.peerPartyId
        : undefined);
    if (!memberPartyId) return notFound(res);
    const sequence = refuseCommonsMember({
      steward: steward.vault,
      grantId,
      memberPartyId,
      now: new Date().toISOString(),
    });
    return sendJson(res, 200, { state: "refused", sequence });
  } catch {
    return notFound(res);
  }
}
