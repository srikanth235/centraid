// governance: allow-repo-hygiene file-size-limit (#750) the peer Commons doors — sync frames with their transfer-session store, one-shot blob authorization, chunk serving, and signed commands — share one authenticated pair boundary; splitting them would split the session state from the routes it authorizes.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  acknowledgeCommonsSeatCursor,
  commonsMemberIdentityChangedReason,
  compactCommonsOperations,
  commonsCurrentSize,
  commonsSeats,
  claimCommonsInvitation,
  executeCommonsCommand,
  exportCommonsBootstrap,
  exportCommonsSyncFrame,
  queueCommonsInvitation,
  readCommonsChainHead,
  readCommonsGrant,
  refuseCommonsMember,
  upsertCommonsMember,
} from "@centraid/vault";
import type {
  CommonsMemberSignature,
  ExecuteCommonsCommandInput,
} from "@centraid/vault";

import type { PeerIdentity } from "./peer-plane.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PEER_COMMONS_BOOTSTRAP_PATH_PREFIX =
  "/centraid/_peer/commons/bootstrap/";
export const PEER_COMMONS_BLOB_AUTH_PATH =
  "/centraid/_peer/commons/blob/authorize";
export const PEER_COMMONS_BLOB_PATH = "/centraid/_peer/commons/blob/chunk";
export const PEER_COMMONS_COMMAND_PATH = "/centraid/_peer/commons/command";
export const PEER_COMMONS_INVITE_PATH = "/centraid/_peer/commons/invite";
export const PEER_COMMONS_CLAIM_PATH = "/centraid/_peer/commons/claim";
export const PEER_COMMONS_REFUSE_PATH = "/centraid/_peer/commons/refuse";

const PEER_COMMONS_SESSION_TTL_MS = 5 * 60 * 1000;
export const PEER_COMMONS_SESSION_CAP = 256;
export const PEER_COMMONS_PAGE_BYTES = 1024 * 1024;

interface PeerCommonsSession {
  stewardVaultId: string;
  memberVaultId: string;
  grantId: string;
  shas?: ReadonlySet<string>;
  frame?: string;
  pageBytes?: number;
  expiresAt: number;
}

const peerCommonsSessions = new Map<string, PeerCommonsSession>();

function openPeerCommonsSession(
  session: Omit<PeerCommonsSession, "expiresAt">
): {
  token: string;
  expiresAt: number;
} {
  const nowMs = Date.now();
  for (const [token, held] of peerCommonsSessions)
    if (held.expiresAt <= nowMs) peerCommonsSessions.delete(token);
  while (peerCommonsSessions.size >= PEER_COMMONS_SESSION_CAP) {
    const oldest = peerCommonsSessions.keys().next().value;
    if (oldest === undefined) break;
    peerCommonsSessions.delete(oldest);
  }
  const token = randomBytes(16).toString("hex");
  const expiresAt = nowMs + PEER_COMMONS_SESSION_TTL_MS;
  peerCommonsSessions.set(token, { ...session, expiresAt });
  return { token, expiresAt };
}

function peerCommonsSession(input: {
  token: string;
  stewardVaultId: string;
  memberVaultId: string;
  grantId?: string;
}): PeerCommonsSession | undefined {
  const held = peerCommonsSessions.get(input.token);
  if (
    !held ||
    held.expiresAt <= Date.now() ||
    held.stewardVaultId !== input.stewardVaultId ||
    held.memberVaultId !== input.memberVaultId ||
    (input.grantId !== undefined && held.grantId !== input.grantId)
  )
    return undefined;
  return held;
}

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
}

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { state: "not_found" });
}

const SIGNATURE_NONCE_GRAMMAR = /^[\x20-\x7E]{1,128}$/u;

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
    const sessionToken = query.get("session");
    if (sessionToken) {
      const page = uint(query.get("page"));
      const session = peerCommonsSession({
        token: sessionToken,
        stewardVaultId: linked.stewardVaultId,
        memberVaultId: linked.memberVaultId,
        grantId,
      });
      if (!session?.frame || !session.pageBytes || page === undefined)
        return notFound(res);
      const pages = Math.ceil(session.frame.length / session.pageBytes);
      if (page >= pages) return notFound(res);
      return sendJson(res, 200, {
        state: "bootstrap-page",
        page,
        pages,
        chunk: session.frame.slice(
          page * session.pageBytes,
          (page + 1) * session.pageBytes
        ),
      });
    }
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
    const acknowledged = uint(query.get("afterSequence"));
    const wantsFull = query.get("full") === "1";
    const frame = exportCommonsSyncFrame({
      steward: steward.vault,
      identitySeed: steward.identitySeed,
      stewardVaultId: linked.stewardVaultId,
      grantId,
      memberVaultId: linked.memberVaultId,
      ...(acknowledged === undefined || wantsFull
        ? {}
        : { afterSequence: acknowledged }),
    });
    const currentSequence =
      frame.state === "tombstone"
        ? frame.tombstone.currentSequence
        : frame.state === "increment"
          ? frame.increment.currentSequence
          : frame.wire.currentSequence;
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
    if (
      frame.state !== "tombstone" &&
      acknowledged !== undefined &&
      acknowledged === currentSequence
    )
      return sendJson(res, 200, {
        state: "current",
        grantId,
        currentSequence,
        headHash: readCommonsChainHead(steward.vault, grantId).hash,
      });
    if (frame.state !== "bootstrap") return sendJson(res, 200, frame);
    const requested = uint(query.get("pageBytes"));
    const pageBytes = Math.min(
      requested && requested >= 4096 ? requested : PEER_COMMONS_PAGE_BYTES,
      PEER_COMMONS_PAGE_BYTES
    );
    const serialized = JSON.stringify(frame);
    if (serialized.length <= pageBytes) return sendJson(res, 200, frame);
    const opened = openPeerCommonsSession({
      stewardVaultId: linked.stewardVaultId,
      memberVaultId: linked.memberVaultId,
      grantId,
      frame: serialized,
      pageBytes,
    });
    return sendJson(res, 200, {
      state: "bootstrap-pages",
      grantId,
      session: opened.token,
      pages: Math.ceil(serialized.length / pageBytes),
      expiresAt: opened.expiresAt,
    });
  } catch {
    return notFound(res);
  }
}

export function handlePeerCommonsBlobAuthorize(
  res: ServerResponse,
  peer: PeerIdentity,
  query: URLSearchParams,
  deps: PeerCommonsRouteDeps
): true {
  const linked = pair(peer, query);
  const grantId = query.get("grantId") ?? "";
  const steward = linked ? deps.vaultFor(linked.stewardVaultId) : undefined;
  if (!linked || !steward || !grantId) return notFound(res);
  try {
    const wire = exportCommonsBootstrap({
      steward: steward.vault,
      identitySeed: steward.identitySeed,
      stewardVaultId: linked.stewardVaultId,
      grantId,
      memberVaultId: linked.memberVaultId,
    });
    const opened = openPeerCommonsSession({
      stewardVaultId: linked.stewardVaultId,
      memberVaultId: linked.memberVaultId,
      grantId,
      shas: new Set(wire.closure.blobs.map((blob) => blob.sha256)),
    });
    return sendJson(res, 200, {
      state: "authorized",
      token: opened.token,
      expiresAt: opened.expiresAt,
    });
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
  const token = query.get("token") ?? "";
  const offset = uint(query.get("offset"));
  const length = uint(query.get("length"));
  const steward = linked ? deps.vaultFor(linked.stewardVaultId) : undefined;
  if (
    !linked ||
    !steward ||
    !grantId ||
    !token ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    offset === undefined ||
    length === undefined ||
    length === 0
  )
    return notFound(res);
  try {
    const session = peerCommonsSession({
      token,
      stewardVaultId: linked.stewardVaultId,
      memberVaultId: linked.memberVaultId,
      grantId,
    });
    if (!session?.shas?.has(sha256)) return notFound(res);
    const stat = steward.blobs.local.statSync(sha256);
    if (!stat || offset > stat.size) return notFound(res);
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
    typeof memberSignature.nonce !== "string" ||
    !SIGNATURE_NONCE_GRAMMAR.test(memberSignature.nonce) ||
    typeof memberSignature.signature !== "string" ||
    memberSignature.signature.length === 0 ||
    memberSignature.memberVaultId !== memberVaultId ||
    typeof basedOnSequence !== "number" ||
    !Number.isInteger(basedOnSequence) ||
    basedOnSequence < 0
  )
    return notFound(res);
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
    if (!boundParty || boundParty.party_id !== actorPartyId) {
      const pinned = steward.vault
        .prepare(
          `SELECT b.party_id FROM share_party_vault_binding b
           JOIN social_circle_member m
             ON m.circle_id = ? AND m.party_id = b.party_id
           WHERE b.vault_id = ? AND b.revoked_at IS NULL
             AND b.vault_public_key IS NOT NULL
             AND b.vault_public_key <> ? LIMIT 1`
        )
        .get(grant.circleId, memberVaultId, link.peerPublicKey) as
        | { party_id: string }
        | undefined;
      if (!pinned) return notFound(res);
      return sendJson(res, 403, {
        state: "refused",
        decision: {
          accepted: false,
          reason: commonsMemberIdentityChangedReason({ memberVaultId }),
        },
      });
    }
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
    presentedVaultPublicKey: link.peerPublicKey,
    basedOnSequence,
    seats: commonsSeats({
      steward: steward.vault,
      grantId,
      stewardVaultId,
      vaultFor: deps.vaultFor,
      invokeFor: (vaultId, replicaCommand, replicaInput, invocationId) => {
        const seatGateway = deps.gatewayFor(vaultId);
        const seatCredential = deps.credentialFor(vaultId);
        if (!seatGateway || !seatCredential)
          throw new Error(`commons replica vault ${vaultId} is not mounted`);
        return seatGateway.invokeCommonsCanonical(
          seatCredential,
          {
            command: replicaCommand,
            input: replicaInput,
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
