// governance: allow-repo-hygiene file-size-limit (#750) the peer Commons doors — sync frames with their transfer-session store, one-shot blob authorization, chunk serving, and signed commands — share one authenticated pair boundary; splitting them would split the session state from the routes it authorizes.
/** Peer-plane snapshot/tail, CAS pull, and signed command doors for Commons. */

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

/**
 * Per-transfer authorization state (#750 defect b): the closure walk +
 * Ed25519 signing happen ONCE at session open, never per 1 MiB chunk; each
 * chunk validates against the session's sha set. Sessions are in-memory/
 * expiring — a restart costs one re-authorize round trip. Same store carries
 * a paginated bootstrap frame (#750 defect d).
 */
const PEER_COMMONS_SESSION_TTL_MS = 5 * 60 * 1000;
/** Server-side ceiling for one bootstrap page; members may ask less, never more. */
export const PEER_COMMONS_PAGE_BYTES = 1024 * 1024;

interface PeerCommonsSession {
  stewardVaultId: string;
  memberVaultId: string;
  grantId: string;
  /** Content addresses this transfer may pull, proven once at open. */
  shas?: ReadonlySet<string>;
  /** Serialized bootstrap frame when the session carries pages. */
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
    // Page fetch for an open session (#750 defect d): slice the stored frame, never re-export.
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
    // full=1 is the member's re-baseline fallback: an increment its replica
    // could not use must force the complete frame without dropping its ack.
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
    // A caught-up member needs no data: a full frame would make the client
    // scrub and re-project the whole commons (deleting seat-local
    // OCR/embeddings/FTS) and count as sweep progress. Tombstones are never
    // short-circuited: a removed member still needs its scrub.
    if (
      frame.state !== "tombstone" &&
      acknowledged !== undefined &&
      acknowledged === currentSequence
    )
      return sendJson(res, 200, {
        state: "current",
        grantId,
        currentSequence,
        // The no-op still carries the chain head (#731): a forked steward must
        // not hide behind "you are caught up".
        headHash: readCommonsChainHead(steward.vault, grantId).hash,
      });
    if (frame.state !== "bootstrap") return sendJson(res, 200, frame);
    // Bound every response (#750 defect d): oversize frames stored once, served in slices.
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

/**
 * Open one blob-pull transfer session (#750 defect b): membership + the
 * grant's current blob set are proven ONCE here; chunks validate against the
 * session instead of re-exporting the closure.
 */
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
    // Chunk authorization rides the authorize-session (#750 defect b):
    // proven once, validated per chunk; no export, no signing.
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
  // The grant sequence the member had projected when it composed this command
  // (#731 goal 1). Member-supplied, untrusted input — it never rode inside the
  // signed intent bytes — so it feeds the stale-context check ONLY and must
  // never widen what `executeCommonsCommand` authorizes. v0 requires it
  // explicitly: no defaulting, no compat branch.
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
  // Bind the acted-as party to the PROVEN peer vault, as the refuse route
  // does: caller-supplied `body.actorPartyId` must never forge
  // steward-attributed writes past capability/signature/replay (all skipped
  // when actorPartyId === stewardPartyId). Resolve from the link's pinned key
  // + circle membership and require a match.
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
      // A member whose vault identity was RE-MINTED still links and signs —
      // it is simply not the pinned key. Named fault with a cure
      // (re-invitation), not a silent 404 (#750).
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
      // Co-hosted member seats replay this command through their OWN gateway
      // (#750 invariant 7); a seat whose vault is not mounted here re-projects
      // from the closure.
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

/** Steward-pushed invitation: the linked vault pair authenticates the inviter;
 * the receiver gets only consent metadata until its owner accepts. */
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

/** Refusal travels the same authenticated pair as claim/accept so control
 * truth and the ordered log stay honest. */
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
